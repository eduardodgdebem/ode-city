// WebGL2 for city.wasm: the imports src/gl.ode declares.
//
// The renderer is the module's (src/render.ode). Each function here forwards
// one call to WebGL and does nothing else. WebGL's objects -- shaders,
// buffers, textures -- stay on this side, in a table, and the module holds
// their indexes, 0 for none. Strings and float arrays are read out of the
// module's memory by address. One view of it serves every call, made
// afresh only once the memory grows, which leaves old views empty.

export function webgl(gl, memory) {
  const objects = [null];
  const keep = (object) => {
    if (object === null) {
      return 0;
    }
    objects.push(object);
    return objects.length - 1;
  };
  const text = (pointer) => {
    const bytes = new Uint8Array(memory().buffer, pointer);
    return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
  };
  let heap = new Float32Array(0);
  const floats = () => {
    if (heap.buffer !== memory().buffer) {
      heap = new Float32Array(memory().buffer);
    }
    return heap;
  };
  // A buffer keeps its storage and is written over in place while what it
  // is given fits, rather than given new storage on every upload; the life
  // mesh goes up each frame. Room is in floats.
  const room = new Map();
  let bound = 0;

  return {
    gl_create_shader(kind, source) {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, text(source));
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('city.wasm: a shader did not compile:', gl.getShaderInfoLog(shader));
        return 0;
      }
      return keep(shader);
    },
    gl_create_program(vertex, fragment) {
      const program = gl.createProgram();
      gl.attachShader(program, objects[vertex]);
      gl.attachShader(program, objects[fragment]);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('city.wasm: a program did not link:', gl.getProgramInfoLog(program));
        return 0;
      }
      return keep(program);
    },
    gl_use_program: (program) => gl.useProgram(objects[program]),
    gl_uniform_location: (program, name) => keep(gl.getUniformLocation(objects[program], text(name))),
    gl_uniform1f: (location, value) => gl.uniform1f(objects[location], value),
    gl_uniform1i: (location, value) => gl.uniform1i(objects[location], value),
    gl_uniform3fv: (location, values) => gl.uniform3fv(objects[location], floats(), values >> 2, 3),
    gl_uniform_matrix4fv: (location, values) => gl.uniformMatrix4fv(objects[location], false, floats(), values >> 2, 16),

    gl_create_vertex_array: () => keep(gl.createVertexArray()),
    gl_bind_vertex_array: (array) => gl.bindVertexArray(objects[array]),
    gl_create_buffer: () => keep(gl.createBuffer()),
    gl_bind_array_buffer(buffer) {
      bound = buffer;
      gl.bindBuffer(gl.ARRAY_BUFFER, objects[buffer]);
    },
    gl_buffer_floats(data, count) {
      if (count === 0) {
        return;
      }
      if (count <= (room.get(bound) ?? 0)) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, floats(), data >> 2, count);
        return;
      }
      // A quarter more than asked, so a mesh that grows a little each frame
      // does not need new storage each frame.
      const size = Math.ceil(count * 1.25);
      gl.bufferData(gl.ARRAY_BUFFER, size * 4, gl.DYNAMIC_DRAW);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, floats(), data >> 2, count);
      room.set(bound, size);
    },
    gl_float_attribute(index, size, stride, offset) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset);
    },
    gl_draw_triangles: (first, count) => gl.drawArrays(gl.TRIANGLES, first, count),

    gl_create_texture: () => keep(gl.createTexture()),
    gl_bind_texture: (texture) => gl.bindTexture(gl.TEXTURE_2D, objects[texture]),
    gl_active_texture: (unit) => gl.activeTexture(unit),
    gl_depth_storage: (size) => gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size),
    gl_texture_parameter: (name, value) => gl.texParameteri(gl.TEXTURE_2D, name, value),
    gl_create_framebuffer: () => keep(gl.createFramebuffer()),
    gl_bind_framebuffer: (framebuffer) => gl.bindFramebuffer(gl.FRAMEBUFFER, objects[framebuffer]),
    gl_depth_attachment(texture) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, objects[texture], 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
    },

    gl_viewport: (x, y, width, height) => gl.viewport(x, y, width, height),
    gl_clear: (mask) => gl.clear(mask),
    gl_enable: (capability) => gl.enable(capability),
    gl_disable: (capability) => gl.disable(capability),
    gl_depth_mask: (on) => gl.depthMask(on !== 0),
    gl_blend_func: (source, destination) => gl.blendFunc(source, destination),
  };
}
