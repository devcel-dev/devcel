#ifndef DEVCEL_RUNTIME_H
#define DEVCEL_RUNTIME_H

#include <stdint.h>

/* Consumers and runtime must use this exact ABI version. */
#define DEVCEL_RUNTIME_API_VERSION 1u

/* Straight-alpha RGBA. Component copying never converts a color space.
 * Color32 bytes are 0..255; ColorFloat RGB is finite/unbounded, alpha is 0..1. */
#ifndef DEVCEL_RUNTIME_COLOR_TYPES
#define DEVCEL_RUNTIME_COLOR_TYPES
typedef struct DevcelColor32 { uint8_t r, g, b, a; } DevcelColor32;
typedef struct DevcelColorFloat { float r, g, b, a; } DevcelColorFloat;
#endif

#ifdef __cplusplus
extern "C" {
#endif

uint32_t devcel_rt_api_version(void);
/* UUID-only table lookup constrained to interface membership; -1 if missing. */
int32_t devcel_rt_record_reference_table(const void* db, const char* table_uuid, const char* required_interface);
void* devcel_rt_open(const char* path);
void* devcel_rt_open_from_json(const char* json);
void devcel_rt_close(void* db);
int32_t devcel_rt_reload_if_changed(const void* db);
const uint8_t* devcel_rt_content_hash(const void* db, int32_t* out_len);
int32_t devcel_rt_table_count(const void* db);
int32_t devcel_rt_table_index(const void* db, const char* name);
int32_t devcel_rt_row_count(const void* db, int32_t table);
int32_t devcel_rt_column_index(const void* db, int32_t table, const char* name);
/* UTF-8 ID, valid until reload/close, null for an invalid row. */
const uint8_t* devcel_rt_row_uuid(const void* db, int32_t table, int32_t row, int32_t* out_len);
int32_t devcel_rt_row_by_uuid(const void* db, int32_t table, const char* uuid);
int32_t devcel_rt_get_i32(const void* db, int32_t table, int32_t row, int32_t col);
int64_t devcel_rt_get_i64(const void* db, int32_t table, int32_t row, int32_t col);
float devcel_rt_get_f32(const void* db, int32_t table, int32_t row, int32_t col);
double devcel_rt_get_f64(const void* db, int32_t table, int32_t row, int32_t col);
int32_t devcel_rt_get_bool(const void* db, int32_t table, int32_t row, int32_t col);
/* UTF-8 bytes, valid only until the same handle is reloaded or closed. */
const uint8_t* devcel_rt_get_str(const void* db, int32_t table, int32_t row, int32_t col, int32_t* out_len);
/* Copies to caller-owned output. Success=1; missing/wrong type/null output=0.
 * Failed calls leave the output unchanged. No normalization or conversion. */
int32_t devcel_rt_get_color32(const void* db, int32_t table, int32_t row, int32_t col, DevcelColor32* out);
int32_t devcel_rt_get_color_float(const void* db, int32_t table, int32_t row, int32_t col, DevcelColorFloat* out);
double devcel_rt_sample_curve(const void* db, int32_t table, int32_t row, int32_t col, double x);
int32_t devcel_rt_resolve_table_ref(const void* db, int32_t table, int32_t row, int32_t col, const char* required_interface);

#ifdef __cplusplus
}
#endif
#endif
