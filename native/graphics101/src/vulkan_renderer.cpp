#include "vulkan_renderer.h"
#include <algorithm>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
void check(VkResult r) { if (r!=VK_SUCCESS) throw std::runtime_error("Vulkan error " + std::to_string(r)); }
}
VKAPI_ATTR VkBool32 VKAPI_CALL VulkanRenderer::debug(VkDebugUtilsMessageSeverityFlagBitsEXT severity, VkDebugUtilsMessageTypeFlagsEXT, const VkDebugUtilsMessengerCallbackDataEXT* data, void* user) {
    if (severity&VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT) ++static_cast<VulkanRenderer*>(user)->validationErrors;
    std::cerr << data->pMessage << '\n';
    return VK_FALSE;
}
VulkanRenderer::VulkanRenderer(HWND hwnd, bool validation, const std::filesystem::path& shaderPath, uint32_t brokerPid):window(hwnd),shaders(shaderPath) {
    try {
        VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO}; app.pApplicationName="Graphics101"; app.apiVersion=VK_API_VERSION_1_1;
        std::vector<const char*> extensions={VK_KHR_SURFACE_EXTENSION_NAME,VK_KHR_WIN32_SURFACE_EXTENSION_NAME};
        const char* layer="VK_LAYER_KHRONOS_validation";
        if (validation) {
            uint32_t count=0; check(vkEnumerateInstanceLayerProperties(&count,nullptr));
            std::vector<VkLayerProperties> layers(count); check(vkEnumerateInstanceLayerProperties(&count,layers.data()));
            if (std::none_of(layers.begin(),layers.end(),[&](auto& x){return !std::strcmp(x.layerName,layer);})) throw std::runtime_error("Validation layer unavailable");
            extensions.push_back(VK_EXT_DEBUG_UTILS_EXTENSION_NAME);
        }
        VkDebugUtilsMessengerCreateInfoEXT dc{VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT};
        dc.messageSeverity=VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT|VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT;
        dc.messageType=VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT|VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT|VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
        dc.pfnUserCallback=debug; dc.pUserData=this;
        VkInstanceCreateInfo ic{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO}; ic.pApplicationInfo=&app;
        ic.enabledExtensionCount=static_cast<uint32_t>(extensions.size()); ic.ppEnabledExtensionNames=extensions.data();
        if (validation) { ic.enabledLayerCount=1; ic.ppEnabledLayerNames=&layer; ic.pNext=&dc; }
        check(vkCreateInstance(&ic,nullptr,&instance));
        if (validation) check(reinterpret_cast<PFN_vkCreateDebugUtilsMessengerEXT>(vkGetInstanceProcAddr(instance,"vkCreateDebugUtilsMessengerEXT"))(instance,&dc,nullptr,&messenger));
        if (window) {
            VkWin32SurfaceCreateInfoKHR sc{VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR}; sc.hinstance=GetModuleHandleW(nullptr); sc.hwnd=window;
            check(vkCreateWin32SurfaceKHR(instance,&sc,nullptr,&surface));
        }
        uint32_t count=0; check(vkEnumeratePhysicalDevices(instance,&count,nullptr));
        std::vector<VkPhysicalDevice> devices(count); check(vkEnumeratePhysicalDevices(instance,&count,devices.data()));
        for (auto candidate:devices) {
            VkPhysicalDeviceProperties props{}; vkGetPhysicalDeviceProperties(candidate,&props);
            if (props.deviceType==VK_PHYSICAL_DEVICE_TYPE_CPU) continue;
            uint32_t n=0; vkGetPhysicalDeviceQueueFamilyProperties(candidate,&n,nullptr);
            std::vector<VkQueueFamilyProperties> queues(n); vkGetPhysicalDeviceQueueFamilyProperties(candidate,&n,queues.data());
            for (uint32_t i=0;i<n;++i) {
                VkBool32 supported=true; if (surface) check(vkGetPhysicalDeviceSurfaceSupportKHR(candidate,i,surface,&supported));
                if ((queues[i].queueFlags&VK_QUEUE_GRAPHICS_BIT) && supported) { physical=candidate; family=i; break; }
            }
            if (physical) { gpuVendor=props.vendorID; gpuDevice=props.deviceID; gpuName=props.deviceName; if (window) std::cout << "GPU: " << props.deviceName << '\n'; break; }
        }
        if (!physical) throw std::runtime_error("No hardware Vulkan graphics/present queue");
        float priority=1;
        VkDeviceQueueCreateInfo qc{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO}; qc.queueFamilyIndex=family; qc.queueCount=1; qc.pQueuePriorities=&priority;
        const char* extension=window?VK_KHR_SWAPCHAIN_EXTENSION_NAME:VK_KHR_EXTERNAL_MEMORY_WIN32_EXTENSION_NAME;
        VkDeviceCreateInfo deviceInfo{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO}; deviceInfo.queueCreateInfoCount=1; deviceInfo.pQueueCreateInfos=&qc; deviceInfo.enabledExtensionCount=1; deviceInfo.ppEnabledExtensionNames=&extension;
        check(vkCreateDevice(physical,&deviceInfo,nullptr,&device)); vkGetDeviceQueue(device,family,0,&queue);
        if (!window) shared=std::make_unique<SharedSurface>(physical,device,brokerPid);
        VkCommandPoolCreateInfo pc{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO}; pc.queueFamilyIndex=family; pc.flags=VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
        check(vkCreateCommandPool(device,&pc,nullptr,&pool));
        VkCommandBufferAllocateInfo ca{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO}; ca.commandPool=pool; ca.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY; ca.commandBufferCount=1;
        check(vkAllocateCommandBuffers(device,&ca,&command));
        VkSemaphoreCreateInfo semaphore{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO}; check(vkCreateSemaphore(device,&semaphore,nullptr,&acquired));
        VkFenceCreateInfo fc{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO}; fc.flags=VK_FENCE_CREATE_SIGNALED_BIT; check(vkCreateFence(device,&fc,nullptr,&fence));
    } catch (...) { cleanup(); throw; }
}
VulkanRenderer::~VulkanRenderer() { cleanup(); }
void VulkanRenderer::finish() {
    check(vkDeviceWaitIdle(device));
    cleanup();
    device={}; surface={}; messenger={}; instance={};
}
void VulkanRenderer::cleanup() {
    if (device) {
        vkDeviceWaitIdle(device); destroyTargets(); shared.reset();
        if (fence) vkDestroyFence(device,fence,nullptr);
        if (acquired) vkDestroySemaphore(device,acquired,nullptr);
        if (pool) vkDestroyCommandPool(device,pool,nullptr);
        vkDestroyDevice(device,nullptr);
    }
    if (surface) vkDestroySurfaceKHR(instance,surface,nullptr);
    if (messenger) reinterpret_cast<PFN_vkDestroyDebugUtilsMessengerEXT>(vkGetInstanceProcAddr(instance,"vkDestroyDebugUtilsMessengerEXT"))(instance,messenger,nullptr);
    if (instance) vkDestroyInstance(instance,nullptr);
}
void VulkanRenderer::destroyTargets() {
    for (auto framebuffer:framebuffers) vkDestroyFramebuffer(device,framebuffer,nullptr); framebuffers.clear();
    if (pipeline) vkDestroyPipeline(device,pipeline,nullptr); pipeline={};
    if (pipelineLayout) vkDestroyPipelineLayout(device,pipelineLayout,nullptr); pipelineLayout={};
    if (renderPass) vkDestroyRenderPass(device,renderPass,nullptr); renderPass={};
    if (depthView) vkDestroyImageView(device,depthView,nullptr); depthView={};
    if (depth) vkDestroyImage(device,depth,nullptr); depth={};
    if (depthMemory) vkFreeMemory(device,depthMemory,nullptr); depthMemory={};
    for (auto view:views) vkDestroyImageView(device,view,nullptr); views.clear();
    for (auto semaphore:presented) vkDestroySemaphore(device,semaphore,nullptr); presented.clear();
    if (swapchain) vkDestroySwapchainKHR(device,swapchain,nullptr); swapchain={};
}
VkShaderModule VulkanRenderer::shader(const char* name) {
    std::ifstream input(shaders/name,std::ios::binary|std::ios::ate);
    if (!input) throw std::runtime_error("Shader missing");
    auto bytes=static_cast<size_t>(input.tellg());
    if (!bytes || bytes%4) throw std::runtime_error("Invalid shader size");
    std::vector<uint32_t> code(bytes/4); input.seekg(0); input.read(reinterpret_cast<char*>(code.data()),static_cast<std::streamsize>(bytes));
    VkShaderModuleCreateInfo sc{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO}; sc.codeSize=bytes; sc.pCode=code.data();
    VkShaderModule module{}; check(vkCreateShaderModule(device,&sc,nullptr,&module)); return module;
}
void VulkanRenderer::createTargets() {
    check(vkDeviceWaitIdle(device)); destroyTargets();
    uint32_t count=0;
    if (shared) {
        extent={sharedWidth,sharedHeight}; format=VK_FORMAT_R8G8B8A8_UNORM;
        shared->create(extent.width,extent.height);
        images.assign(shared->images.begin(),shared->images.end()); sharedInitialized.fill(false);
    } else {
    VkSurfaceCapabilitiesKHR caps{}; check(vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physical,surface,&caps));
    check(vkGetPhysicalDeviceSurfaceFormatsKHR(physical,surface,&count,nullptr));
    std::vector<VkSurfaceFormatKHR> formats(count); check(vkGetPhysicalDeviceSurfaceFormatsKHR(physical,surface,&count,formats.data()));
    auto chosen=formats.front();
    for (auto candidate:formats) if (candidate.format==VK_FORMAT_B8G8R8A8_UNORM && candidate.colorSpace==VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) chosen=candidate;
    format=chosen.format;
    RECT rect{}; GetClientRect(window,&rect);
    extent=caps.currentExtent;
    if (extent.width==UINT32_MAX) extent={std::clamp(static_cast<uint32_t>(rect.right),caps.minImageExtent.width,caps.maxImageExtent.width),std::clamp(static_cast<uint32_t>(rect.bottom),caps.minImageExtent.height,caps.maxImageExtent.height)};
    VkSwapchainCreateInfoKHR sc{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR}; sc.surface=surface;
    sc.minImageCount=caps.minImageCount+1; if (caps.maxImageCount) sc.minImageCount=std::min(sc.minImageCount,caps.maxImageCount);
    sc.imageFormat=format; sc.imageColorSpace=chosen.colorSpace; sc.imageExtent=extent; sc.imageArrayLayers=1; sc.imageUsage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    sc.preTransform=caps.currentTransform; sc.compositeAlpha=VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR; sc.presentMode=VK_PRESENT_MODE_FIFO_KHR; sc.clipped=VK_TRUE;
    check(vkCreateSwapchainKHR(device,&sc,nullptr,&swapchain));
    check(vkGetSwapchainImagesKHR(device,swapchain,&count,nullptr)); images.resize(count); check(vkGetSwapchainImagesKHR(device,swapchain,&count,images.data()));
    }
    for (auto image:images) {
        VkImageViewCreateInfo vc{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO}; vc.image=image; vc.viewType=VK_IMAGE_VIEW_TYPE_2D; vc.format=format;
        vc.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1}; VkImageView view{}; check(vkCreateImageView(device,&vc,nullptr,&view)); views.push_back(view);
        VkSemaphoreCreateInfo sem{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO}; VkSemaphore signal{}; check(vkCreateSemaphore(device,&sem,nullptr,&signal)); presented.push_back(signal);
    }
    VkFormatProperties depthProps{}; vkGetPhysicalDeviceFormatProperties(physical,VK_FORMAT_D32_SFLOAT,&depthProps);
    if (!(depthProps.optimalTilingFeatures&VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT)) throw std::runtime_error("D32 depth unsupported");
    VkImageCreateInfo di{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO}; di.imageType=VK_IMAGE_TYPE_2D; di.format=VK_FORMAT_D32_SFLOAT; di.extent={extent.width,extent.height,1}; di.mipLevels=1; di.arrayLayers=1; di.samples=VK_SAMPLE_COUNT_1_BIT; di.tiling=VK_IMAGE_TILING_OPTIMAL; di.usage=VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
    check(vkCreateImage(device,&di,nullptr,&depth));
    VkMemoryRequirements req{}; vkGetImageMemoryRequirements(device,depth,&req);
    VkPhysicalDeviceMemoryProperties memoryProps{}; vkGetPhysicalDeviceMemoryProperties(physical,&memoryProps);
    uint32_t type=0;
    while (type<memoryProps.memoryTypeCount && (!(req.memoryTypeBits&(1u<<type)) || !(memoryProps.memoryTypes[type].propertyFlags&VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT))) ++type;
    if (type==memoryProps.memoryTypeCount) throw std::runtime_error("No depth memory type");
    VkMemoryAllocateInfo ma{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; ma.allocationSize=req.size; ma.memoryTypeIndex=type;
    check(vkAllocateMemory(device,&ma,nullptr,&depthMemory)); check(vkBindImageMemory(device,depth,depthMemory,0));
    VkImageViewCreateInfo dv{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO}; dv.image=depth; dv.viewType=VK_IMAGE_VIEW_TYPE_2D; dv.format=VK_FORMAT_D32_SFLOAT; dv.subresourceRange={VK_IMAGE_ASPECT_DEPTH_BIT,0,1,0,1};
    check(vkCreateImageView(device,&dv,nullptr,&depthView));
    VkAttachmentDescription attachments[2]{};
    attachments[0].format=format; attachments[0].samples=VK_SAMPLE_COUNT_1_BIT; attachments[0].loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR; attachments[0].storeOp=VK_ATTACHMENT_STORE_OP_STORE; attachments[0].stencilLoadOp=VK_ATTACHMENT_LOAD_OP_DONT_CARE; attachments[0].stencilStoreOp=VK_ATTACHMENT_STORE_OP_DONT_CARE; attachments[0].finalLayout=VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
    attachments[1].format=VK_FORMAT_D32_SFLOAT; attachments[1].samples=VK_SAMPLE_COUNT_1_BIT; attachments[1].loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR; attachments[1].storeOp=VK_ATTACHMENT_STORE_OP_DONT_CARE; attachments[1].stencilLoadOp=VK_ATTACHMENT_LOAD_OP_DONT_CARE; attachments[1].stencilStoreOp=VK_ATTACHMENT_STORE_OP_DONT_CARE; attachments[1].finalLayout=VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
    if (shared) { attachments[0].initialLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL; attachments[0].finalLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL; }
    VkAttachmentReference color{0,VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL}, depthRef{1,VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
    VkSubpassDescription sub{}; sub.pipelineBindPoint=VK_PIPELINE_BIND_POINT_GRAPHICS; sub.colorAttachmentCount=1; sub.pColorAttachments=&color; sub.pDepthStencilAttachment=&depthRef;
    VkSubpassDependency dependency{}; dependency.srcSubpass=VK_SUBPASS_EXTERNAL; dependency.dstSubpass=0;
    dependency.srcStageMask=dependency.dstStageMask=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT|VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT|VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
    dependency.srcAccessMask=VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT; dependency.dstAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT|VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
    VkRenderPassCreateInfo rp{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO}; rp.attachmentCount=2; rp.pAttachments=attachments; rp.subpassCount=1; rp.pSubpasses=&sub; rp.dependencyCount=1; rp.pDependencies=&dependency;
    check(vkCreateRenderPass(device,&rp,nullptr,&renderPass));
    VkPushConstantRange push{VK_SHADER_STAGE_VERTEX_BIT,0,64};
    VkPipelineLayoutCreateInfo pl{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO}; pl.pushConstantRangeCount=1; pl.pPushConstantRanges=&push;
    check(vkCreatePipelineLayout(device,&pl,nullptr,&pipelineLayout));
    VkShaderModule vert=shader("triangle.vert.spv"), frag{};
    try {
        frag=shader("triangle.frag.spv");
        VkPipelineShaderStageCreateInfo stages[2]{};
        for (auto& stage:stages) { stage.sType=VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO; stage.pName="main"; }
        stages[0].stage=VK_SHADER_STAGE_VERTEX_BIT; stages[0].module=vert; stages[1].stage=VK_SHADER_STAGE_FRAGMENT_BIT; stages[1].module=frag;
        VkPipelineVertexInputStateCreateInfo vi{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
        VkPipelineInputAssemblyStateCreateInfo ia{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO}; ia.topology=VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
        VkPipelineViewportStateCreateInfo vs{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO}; vs.viewportCount=1; vs.scissorCount=1;
        VkPipelineRasterizationStateCreateInfo rs{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO}; rs.polygonMode=VK_POLYGON_MODE_FILL; rs.lineWidth=1; rs.cullMode=VK_CULL_MODE_NONE;
        VkPipelineMultisampleStateCreateInfo ms{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO}; ms.rasterizationSamples=VK_SAMPLE_COUNT_1_BIT;
        VkPipelineDepthStencilStateCreateInfo ds{VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO}; ds.depthTestEnable=VK_TRUE; ds.depthWriteEnable=VK_TRUE; ds.depthCompareOp=VK_COMPARE_OP_LESS;
        VkPipelineColorBlendAttachmentState blend{}; blend.colorWriteMask=15;
        VkPipelineColorBlendStateCreateInfo bs{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO}; bs.attachmentCount=1; bs.pAttachments=&blend;
        VkDynamicState states[]={VK_DYNAMIC_STATE_VIEWPORT,VK_DYNAMIC_STATE_SCISSOR};
        VkPipelineDynamicStateCreateInfo dynamic{VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO}; dynamic.dynamicStateCount=2; dynamic.pDynamicStates=states;
        VkGraphicsPipelineCreateInfo gp{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO}; gp.stageCount=2; gp.pStages=stages; gp.pVertexInputState=&vi; gp.pInputAssemblyState=&ia; gp.pViewportState=&vs; gp.pRasterizationState=&rs; gp.pMultisampleState=&ms; gp.pDepthStencilState=&ds; gp.pColorBlendState=&bs; gp.pDynamicState=&dynamic; gp.layout=pipelineLayout; gp.renderPass=renderPass;
        check(vkCreateGraphicsPipelines(device,{},1,&gp,nullptr,&pipeline));
    } catch (...) { if (frag) vkDestroyShaderModule(device,frag,nullptr); vkDestroyShaderModule(device,vert,nullptr); throw; }
    vkDestroyShaderModule(device,frag,nullptr); vkDestroyShaderModule(device,vert,nullptr);
    for (auto view:views) {
        VkImageView pair[]={view,depthView}; VkFramebufferCreateInfo fc{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO}; fc.renderPass=renderPass; fc.attachmentCount=2; fc.pAttachments=pair; fc.width=extent.width; fc.height=extent.height; fc.layers=1;
        VkFramebuffer framebuffer{}; check(vkCreateFramebuffer(device,&fc,nullptr,&framebuffer)); framebuffers.push_back(framebuffer);
    }
    dirty=false;
}
bool VulkanRenderer::draw(const std::array<float,16>& matrix) {
    RECT rect{}; GetClientRect(window,&rect);
    if (IsIconic(window) || rect.right==0 || rect.bottom==0) return false;
    if (dirty) createTargets();
    check(vkWaitForFences(device,1,&fence,VK_TRUE,UINT64_MAX));
    uint32_t index=0; VkResult result=vkAcquireNextImageKHR(device,swapchain,UINT64_MAX,acquired,{},&index);
    if (result==VK_ERROR_OUT_OF_DATE_KHR) { dirty=true; return false; }
    if (result!=VK_SUBOPTIMAL_KHR) check(result); else dirty=true;
    record(matrix,index);
    VkPipelineStageFlags wait=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO}; submit.waitSemaphoreCount=1; submit.pWaitSemaphores=&acquired; submit.pWaitDstStageMask=&wait; submit.commandBufferCount=1; submit.pCommandBuffers=&command; submit.signalSemaphoreCount=1; submit.pSignalSemaphores=&presented[index];
    check(vkResetFences(device,1,&fence)); check(vkQueueSubmit(queue,1,&submit,fence));
    VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR}; present.waitSemaphoreCount=1; present.pWaitSemaphores=&presented[index]; present.swapchainCount=1; present.pSwapchains=&swapchain; present.pImageIndices=&index;
    result=vkQueuePresentKHR(queue,&present);
    if (result==VK_ERROR_OUT_OF_DATE_KHR || result==VK_SUBOPTIMAL_KHR) dirty=true; else check(result);
    ++frames;
    return true;
}
void VulkanRenderer::record(const std::array<float,16>& matrix, uint32_t index) {
    check(vkResetCommandBuffer(command,0));
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; begin.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vkBeginCommandBuffer(command,&begin));
    if (shared) {
        VkImageMemoryBarrier acquire{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
        acquire.oldLayout=sharedInitialized[index]?VK_IMAGE_LAYOUT_GENERAL:VK_IMAGE_LAYOUT_UNDEFINED; acquire.newLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
        acquire.srcQueueFamilyIndex=VK_QUEUE_FAMILY_EXTERNAL; acquire.dstQueueFamilyIndex=family;
        acquire.dstAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT; acquire.image=images[index]; acquire.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
        vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,0,0,nullptr,0,nullptr,1,&acquire);
    }
    VkClearValue clears[2]{}; clears[0].color={{0.025f,0.045f,0.08f,1}}; clears[1].depthStencil={1,0};
    VkRenderPassBeginInfo render{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO}; render.renderPass=renderPass; render.framebuffer=framebuffers[index]; render.renderArea.extent=extent; render.clearValueCount=2; render.pClearValues=clears;
    vkCmdBeginRenderPass(command,&render,VK_SUBPASS_CONTENTS_INLINE);
    VkViewport viewport{0,0,static_cast<float>(extent.width),static_cast<float>(extent.height),0,1}; VkRect2D scissor{{0,0},extent};
    vkCmdSetViewport(command,0,1,&viewport); vkCmdSetScissor(command,0,1,&scissor);
    vkCmdBindPipeline(command,VK_PIPELINE_BIND_POINT_GRAPHICS,pipeline); vkCmdPushConstants(command,pipelineLayout,VK_SHADER_STAGE_VERTEX_BIT,0,64,matrix.data());
    vkCmdDraw(command,3,1,0,0); vkCmdEndRenderPass(command);
    if (shared) {
        VkImageMemoryBarrier release{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};
        release.oldLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL; release.newLayout=VK_IMAGE_LAYOUT_GENERAL;
        release.srcQueueFamilyIndex=family; release.dstQueueFamilyIndex=VK_QUEUE_FAMILY_EXTERNAL;
        release.srcAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT; release.image=images[index]; release.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
        vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,0,0,nullptr,0,nullptr,1,&release);
    }
    check(vkEndCommandBuffer(command));
}
void VulkanRenderer::sharedResize(uint32_t width, uint32_t height) {
    sharedWidth=width; sharedHeight=height; createTargets();
}
void VulkanRenderer::sharedDraw(const std::array<float,16>& matrix, uint32_t slot) {
    check(vkWaitForFences(device,1,&fence,VK_TRUE,UINT64_MAX));
    record(matrix,slot);
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO}; submit.commandBufferCount=1; submit.pCommandBuffers=&command;
    check(vkResetFences(device,1,&fence)); check(vkQueueSubmit(queue,1,&submit,fence));
    check(vkWaitForFences(device,1,&fence,VK_TRUE,UINT64_MAX));
    sharedInitialized[slot]=true; ++frames;
}
