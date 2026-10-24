#include "camera.h"
#include <algorithm>
#include <cmath>
#include <iostream>

namespace {
using V = std::array<float, 3>;
using M = std::array<float, 16>;
V cross(V a, V b) { return {a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]}; }
float dot(V a, V b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
V normalize(V a) { float n = std::sqrt(dot(a,a)); for (auto& x : a) x /= n; return a; }
M multiply(M a, M b) {
    M result{};
    for (int c=0; c<4; ++c) for (int r=0; r<4; ++r)
        for (int k=0; k<4; ++k) result[c*4+r] += a[k*4+r]*b[c*4+k];
    return result;
}
}
void Camera::reset() { yaw=0; pitch=0; distance=3; target={}; angle=0; rotating=true; keys.fill(false); ++inputSeq; }
void Camera::orbit(float dx, float dy) { yaw += dx*0.008f; pitch=std::clamp(pitch+dy*0.008f,-1.45f,1.45f); ++inputSeq; }
void Camera::dolly(float delta) { distance=std::clamp(distance*std::exp(-delta*0.12f),0.5f,30.0f); ++inputSeq; }
void Camera::key(unsigned code, bool down) {
    if (code >= keys.size() || keys[code] == down) return;
    keys[code]=down;
    ++inputSeq;
    if (down && code=='R') reset();
    if (down && code==32) rotating=!rotating;
}
void Camera::focusLost() { keys.fill(false); ++inputSeq; }
void Camera::update(float dt) {
    dt=std::clamp(dt,0.0f,0.1f);
    float forward=static_cast<float>(keys['W'])-static_cast<float>(keys['S']);
    float side=static_cast<float>(keys['D'])-static_cast<float>(keys['A']);
    target[0] += (side*std::cos(yaw)-forward*std::sin(yaw))*dt*2;
    target[2] += (-side*std::sin(yaw)-forward*std::cos(yaw))*dt*2;
    target[1] += (static_cast<float>(keys['E'])-static_cast<float>(keys['Q']))*dt*2;
    if (rotating) angle+=dt*0.6f;
}
std::array<float,16> Camera::matrix(float aspect) const {
    V z={std::sin(yaw)*std::cos(pitch),std::sin(pitch),std::cos(yaw)*std::cos(pitch)};
    V eye={target[0]+distance*z[0],target[1]+distance*z[1],target[2]+distance*z[2]};
    V x=normalize(cross({0,1,0},z)), y=cross(z,x);
    M view={x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1};
    float f=1/std::tan(0.5235987756f), near=0.05f, far=100;
    M projection={f/aspect,0,0,0,0,-f,0,0,0,0,far/(near-far),-1,0,0,near*far/(near-far),0};
    float c=std::cos(angle), s=std::sin(angle);
    M model={c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1};
    return multiply(projection,multiply(view,model));
}
int cameraTest() {
    Camera c;
    c.rotating=false;
    auto initial=c.matrix(1);
    c.orbit(40,10000);
    if (c.pitch>1.45f || c.matrix(1)==initial) return 1;
    c.dolly(10000);
    if (c.distance!=0.5f) return 2;
    c.key('W',true); c.update(0.1f);
    auto moved=c.target;
    c.focusLost(); c.update(0.1f);
    if (c.target!=moved) return 3;
    c.key('R',true);
    if (c.target!=std::array<float,3>{} || c.distance!=3 || c.pitch!=0) return 4;
    if (c.matrix(1)==c.matrix(2)) return 5;
    c.key(32,true);
    if (c.rotating) return 6;
    std::cout << "{\"cameraTests\":\"passed\",\"inputSeq\":" << c.inputSeq << "}\n";
    return 0;
}
