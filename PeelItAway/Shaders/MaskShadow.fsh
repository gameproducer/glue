uniform sampler2D u_mask;

void main() {
    float alpha = texture2D(u_texture, v_tex_coord).a * texture2D(u_mask, v_tex_coord).a;
    gl_FragColor = vec4(vec3(0.08, 0.04, 0.10) * alpha, alpha) * v_color_mix.a;
}
