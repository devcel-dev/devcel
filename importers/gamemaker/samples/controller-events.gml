// CREATE event (paste each section into the matching event of your own controller object):
master = new DevcelDatabase("base");
if (!master.load_file("devcel/base.json")) show_error(master.last_error,true);
var hero = master.by_id("Heroes","hero-1");
show_debug_message(hero.get("hp"));
show_debug_message(hero.get("wide")); // Exact decimal string, including values above 2^53.
show_debug_message(hero.get("color_float").g); // 2.0, not clamped.
// Optional: paste the current session runtime URL from importer UI. Never commit the token.
// if (debug_mode) master.watch_http("http://127.0.0.1:PORT/runtime/base?token=TOKEN",1);

// STEP event:
master.update(delta_time / 1000000);

// ASYNCHRONOUS > HTTP event:
var result = master.handle_http(async_load);
if (result.changed) show_debug_message("Devcel data updated");

// CLEAN UP event:
master.stop_watch();
