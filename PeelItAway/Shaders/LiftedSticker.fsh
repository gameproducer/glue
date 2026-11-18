uniform sampler2D u_mask;
uniform sampler2D u_back_texture;
uniform vec2 u_front;
uniform vec2 u_pull_direction;
uniform float u_radius;
uniform float u_tension;
uniform float u_cone;

void main() {
    vec4 frontColor = texture2D(u_texture, v_tex_coord);
    vec4 backColor = texture2D(u_back_texture, v_tex_coord);
    float mask = texture2D(u_mask, v_tex_coord).a;

    vec2 delta = v_tex_coord - u_front;
    float along = max(0.0, dot(delta, u_pull_direction));
    float localRadius = max(0.001, u_radius * (1.0 + u_cone * dot(delta, vec2(-u_pull_direction.y, u_pull_direction.x))));
    float theta = min(1.5707963, along / localRadius);

    float backside = smoothstep(0.72, 1.42, theta);
    float highlight = exp(-pow((theta - 0.55) * 2.2, 2.0)) * 0.20;
    float edgeShade = 1.0 - smoothstep(1.10, 1.57, theta) * 0.28;
    float stressWhite = min(0.16, u_tension * 0.010) * smoothstep(0.45, 1.35, theta);

    vec4 paper = mix(frontColor, backColor, backside);
    paper.rgb = paper.rgb * edgeShade + highlight + stressWhite;
    gl_FragColor = vec4(paper.rgb * mask, paper.a * mask);
}
