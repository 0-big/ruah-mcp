// Lossy PNG quantisation for encode.ts: libimagequant 2.4.1 (BSD-2-Clause, see LICENSE) behind one
// plain wasm export. RGBA in → the same buffer remapped to a ≤256-colour palette, still RGBA; the
// caller encodes it as PNG and OxiPNG turns it into an indexed PNG. Built by build.sh.
#include <stdlib.h>
#include "libimagequant.h"

#define EXPORT __attribute__((used, visibility("default")))

EXPORT void *liq_alloc(size_t n) { return malloc(n); }
EXPORT void liq_dealloc(void *p) { free(p); }

/** Returns 0 on success, otherwise a liq_error code (or -1 when out of memory). */
EXPORT int quantise(unsigned char *rgba, int width, int height, int max_quality, int speed, float dither) {
  liq_attr *attr = liq_attr_create();
  if (!attr) return -1;
  liq_set_max_colors(attr, 256);
  liq_set_quality(attr, 0, max_quality); // minimum 0: never gives up, only spends fewer colours
  liq_set_speed(attr, speed);
  liq_image *img = liq_image_create_rgba(attr, rgba, width, height, 0);
  if (!img) {
    liq_attr_destroy(attr);
    return -1;
  }
  int err = 0;
  liq_result *res = liq_quantize_image(attr, img);
  if (!res) {
    err = -1;
  } else {
    size_t n = (size_t)width * height;
    unsigned char *idx = malloc(n);
    // Row pointers on the heap: liq_write_remapped_image keeps them in a stack array of `height`
    // entries, which overflows the 64 KiB wasm stack from ~14,000 rows (a long screenshot).
    unsigned char **rows = malloc(sizeof(*rows) * height);
    if (!idx || !rows) {
      err = -1;
    } else {
      for (int y = 0; y < height; y++) rows[y] = idx + (size_t)width * y;
      liq_set_dithering_level(res, dither);
      err = liq_write_remapped_image_rows(res, img, rows);
      if (!err) {
        // idx is complete, so the input can now be overwritten with the palette colours.
        const liq_palette *pal = liq_get_palette(res);
        for (size_t i = 0; i < n; i++) {
          liq_color c = pal->entries[idx[i]];
          rgba[i * 4] = c.r;
          rgba[i * 4 + 1] = c.g;
          rgba[i * 4 + 2] = c.b;
          rgba[i * 4 + 3] = c.a;
        }
      }
    }
    free(rows);
    free(idx);
    liq_result_destroy(res);
  }
  liq_image_destroy(img);
  liq_attr_destroy(attr);
  return err;
}
