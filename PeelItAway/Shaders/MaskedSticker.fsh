uniform sampler2D u_mask;

void main() {
    vec4 color = texture2D(u_texture, v_tex_coord);
    float mask = texture2D(u_mask, v_tex_coord).a;
    gl_FragColor = color * mask;
}
