#pragma once
#include <vulkan/vulkan.h>
#include <array>
#include <atomic>
#include <filesystem>
#include <vector>
#include <memory>
#include "shared_surface_win32.h"

class VulkanRenderer {
public:
    VulkanRenderer(HWND window, bool validation, const std::filesystem::path& shaders, uint32_t brokerPid=0);
    void sharedResize(uint32_t width, uint32_t height);
    void sharedDraw(const std::array<float,16>& matrix, uint32_t slot);
    uint64_t sharedHandle(uint32_t slot) const { return shared->handles.at(slot); }
    uint32_t gpuVendor=0, gpuDevice=0;
    std::string gpuName;
    ~VulkanRenderer();
    bool draw(const std::array<float,16>& matrix);
    void resize() { dirty=true; }
    void finish();
    uint64_t frames=0;
    std::atomic_uint validationErrors=0;
private:
    VkInstance instance{};
    VkDebugUtilsMessengerEXT messenger{};
    VkSurfaceKHR surface{};
    VkPhysicalDevice physical{};
    VkDevice device{};
    uint32_t family=0;
    VkQueue queue{};
    VkSwapchainKHR swapchain{};
    VkFormat format{};
    VkExtent2D extent{};
    std::vector<VkImage> images;
    std::vector<VkImageView> views;
    std::vector<VkFramebuffer> framebuffers;
    std::vector<VkSemaphore> presented;
    VkImage depth{};
    VkDeviceMemory depthMemory{};
    VkImageView depthView{};
    VkRenderPass renderPass{};
    VkPipelineLayout pipelineLayout{};
    VkPipeline pipeline{};
    VkCommandPool pool{};
    VkCommandBuffer command{};
    VkSemaphore acquired{};
    VkFence fence{};
    HWND window{};
    bool dirty=true;
    std::unique_ptr<SharedSurface> shared;
    uint32_t sharedWidth=0, sharedHeight=0;
    std::array<bool,4> sharedInitialized{};
    void record(const std::array<float,16>& matrix, uint32_t index);
    std::filesystem::path shaders;
    void createTargets();
    void destroyTargets();
    void cleanup();
    VkShaderModule shader(const char* name);
    static VKAPI_ATTR VkBool32 VKAPI_CALL debug(VkDebugUtilsMessageSeverityFlagBitsEXT, VkDebugUtilsMessageTypeFlagsEXT, const VkDebugUtilsMessengerCallbackDataEXT*, void*);
};
