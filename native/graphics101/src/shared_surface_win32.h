#pragma once
#include <vulkan/vulkan.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <array>

class SharedSurface {
public:
    SharedSurface(VkPhysicalDevice physical, VkDevice device, uint32_t targetPid);
    ~SharedSurface();
    void create(uint32_t width, uint32_t height);
    void clear();
    std::array<VkImage,4> images{};
    std::array<uint64_t,4> handles{};
private:
    VkDevice device{};
    VkPhysicalDevice physical{};
    HANDLE target{};
    Microsoft::WRL::ComPtr<ID3D11Device> d3d;
    std::array<Microsoft::WRL::ComPtr<ID3D11Texture2D>,4> textures;
    std::array<VkDeviceMemory,4> memory{};
};
