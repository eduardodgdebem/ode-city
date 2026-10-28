# Ode City

A focus timer that builds a city while you work, written in Ode and compiled
to WebAssembly.

Set a timer and a building goes up on the next plot: the longer the session,
the bigger the building, from a house to a skyscraper. A pomodoro cycle
raises one building across all its rounds and opens a park beside it. Give up
and the construction collapses into a ruin. The city is procedurally
generated from a seed and grows outward a block at a time, rendered in 3D
with WebGL2: shadows, lit windows at night, and a sky that follows your local
time.

It is a PWA: it installs to the home screen, runs offline, and keeps
everything on the device.

## Building

You need the Ode compiler, and LLVM with `wasm-ld` for the wasm32 target.

```bash
ode build          # src/ -> web/city.wasm
ode build test     # the tests
ode build serve    # serve web/ on http://localhost:8080
```

## Layout

- `src/` -- the app, in Ode: the timer, the game's rules, the procedural
  city, its meshes, the camera, the sky, and the renderer with its shaders.
- `web/` -- the page: the panel, storage, input, the WebGL bindings, and the
  service worker. Any static host serves it as it is.
- `tools/serve.ode` -- a small static file server for trying it out.
