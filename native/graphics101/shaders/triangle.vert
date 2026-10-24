#version 450
layout(push_constant) uniform Transform { mat4 mvp; } transform;
layout(location = 0) out vec3 color;
const vec3 positions[3] = vec3[](vec3(-0.9, -0.7, 0.15), vec3(0.9, -0.7, -0.15), vec3(0.0, 0.9, 0.0));
const vec3 colors[3] = vec3[](vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));
void main() {
    gl_Position = transform.mvp * vec4(positions[gl_VertexIndex], 1);
    color = colors[gl_VertexIndex];
}
