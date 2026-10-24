#pragma once
#include <array>
#include <cstdint>

struct Camera {
    float yaw = 0, pitch = 0, distance = 3;
    std::array<float, 3> target{};
    std::array<bool, 256> keys{};
    bool rotating = true;
    float angle = 0;
    uint64_t inputSeq = 0;
    void reset();
    void orbit(float dx, float dy);
    void dolly(float delta);
    void key(unsigned code, bool down);
    void focusLost();
    void update(float dt);
    std::array<float, 16> matrix(float aspect) const;
};
int cameraTest();
