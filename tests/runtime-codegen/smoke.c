#include "devcel_runtime.h"
#include <assert.h>
#include <stddef.h>
#include <stdio.h>

_Static_assert(sizeof(DevcelColor32) == 4, "Color32 size");
_Static_assert(sizeof(DevcelColorFloat) == 16, "ColorFloat size");
_Static_assert(offsetof(DevcelColor32, a) == 3, "Color32 alpha offset");
_Static_assert(offsetof(DevcelColorFloat, a) == 12, "ColorFloat alpha offset");

int main(int argc, char** argv) {
    assert(argc == 2);
    assert(devcel_rt_api_version() == DEVCEL_RUNTIME_API_VERSION);
    void* db = devcel_rt_open(argv[1]);
    assert(db);
    int32_t table = devcel_rt_table_index(db, "heroes");
    int32_t row = devcel_rt_row_by_uuid(db, table, "22222222-2222-4222-8222-222222222222");
    int32_t byte_col = devcel_rt_column_index(db, table, "tint");
    int32_t float_col = devcel_rt_column_index(db, table, "light");
    DevcelColor32 bytes = {0};
    DevcelColorFloat floats = {0};
    assert(devcel_rt_get_color32(db, table, row, byte_col, &bytes) == 1);
    assert(bytes.r == 18 && bytes.g == 171 && bytes.b == 239 && bytes.a == 0);
    assert(devcel_rt_get_color_float(db, table, row, float_col, &floats) == 1);
    assert(floats.r == -.25f && floats.g == 4.f && floats.b == .5f && floats.a == 0.f);
    assert(devcel_rt_get_color32(db, table, row, float_col, &bytes) == 0);
    assert(bytes.r == 18 && bytes.a == 0);
    assert(devcel_rt_get_color_float(db, table, -1, float_col, &floats) == 0);
    assert(floats.g == 4.f);
    assert(devcel_rt_get_color32(db, table, row, byte_col, NULL) == 0);
    devcel_rt_close(db);
    assert(bytes.r == 18 && floats.g == 4.f); /* Copies remain valid. */
    puts("C runtime ABI: RGBA layout, typed getters, HDR/transparent RGB, failure outputs PASS");
    return 0;
}
