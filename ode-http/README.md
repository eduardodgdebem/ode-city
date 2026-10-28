# ode-http

A small web server framework for [Ode](../README.md): routes with path
parameters, middleware, requests and responses, and static files.

```rust
import { Builder } from "std/text";
import { App, Request, Response } from "../ode-http/http";

fn hello(request: *Request, response: *Response): void {
  let out: *Builder = Builder.new();
  out.add("hello, ");
  out.add(request.param("name"));
  response.text(200, out.take());
}

fn main(): i32 {
  let app: *App = App.new();
  app.get("/hello/:name", hello);
  app.serveStatic("/", "public");
  app.listen(8080) catch (e) {
    return 1;
  };
  return 0;
}
```

`ode build hello` runs [`examples/hello.ode`](examples/hello.ode), a tour of
all of it, on http://localhost:8090.

## The API

All of it is in [`http.ode`](http.ode).

**`App`**

| | |
|---|---|
| `App.new()` | an app with no routes |
| `get`, `post`, `put`, `patch`, `delete(pattern, handler)` | a route; `route(method, pattern, handler)` for any `Method` |
| `use(middleware)` | runs before the routes, in the order added; returning `false` means it answered |
| `serveStatic(prefix, dir)` | GET and HEAD under `prefix` from the files in `dir`; a directory is its `index.html` |
| `notFound` | the handler when nothing else answers; 404 by default |
| `log` | whether each request is printed with its status; on by default |
| `data` | anything the handlers share (see below) |
| `handle(request, response)` | runs a request through the app without a network, for tests |
| `listen(port)` | serves until the process ends: `void \| ServeError` |

**Patterns**: `/about` matches itself, `/users/:id` takes any one part as
`id`, and `/files/*` takes the rest of the path as `*`. A slash at the end of
a path is ignored. The first route to match wins; a path that matches only
other methods' routes is 405. HEAD is answered by the GET route.

**`Request`**: `method` (a `Method`) and `methodName`, `path` (decoded),
`query` and `target` (as sent), `version`, `headers`, `body` and
`bodyLength`; `header(name)`, `param(name)` and `queryParam(name)`, each null
when absent. Header names ignore case.

**`Response`**: `status`, `headers` and `body` (a `Builder`), filled in by
`text`, `html`, `json`, `send(status, contentType, body)` and
`redirect(location)`, or directly; `setHeader(name, value)` replaces a header
of the same name.

## How it runs

Each connection is answered by a process forked from the server, then
closed: one request per connection, no keep-alive. A slow or idle
connection -- browsers open some before they have anything to send -- holds
up only its own process, and a crash takes down only its own request.

That has one consequence to know: **a handler's changes to globals end with
its process**. Anything that must outlive a request belongs in a file or a
database. And since Ode's lambdas capture nothing, handlers are plain
functions, and what they share is reached through `request.app.data`.

## Limits, for now

- HTTP/1.1 only, without keep-alive, TLS or chunked bodies; a chunked
  request is refused as malformed.
- A request's head may be 16 KiB, and its body 8 MiB.
- Responses are built whole in memory, or streamed from a file.
- macOS and Linux.

## Tests

`ode test ode-http/http.ode` runs them, and `ode build test` with the rest.
Parsing, routing and the app's handling are tested without a network:
`App.handle` takes a `Request` and fills in a `Response`.
