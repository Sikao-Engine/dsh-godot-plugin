#include "shared_surface_win32.h"
#include <dxgi1_2.h>
#include <cstring>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
namespace {
void check(VkResult result) { if (result!=VK_SUCCESS) throw std::runtime_error("Shared surface Vulkan error "+std::to_string(result)); }
void checkHR(HRESULT result) { if (FAILED(result)) throw std::runtime_error("Shared surface D3D error "+std::to_string(result)); }
}
SharedSurface::SharedSurface(VkPhysicalDevice gpu, VkDevice vk, uint32_t pid):device(vk),physical(gpu) {
    VkPhysicalDeviceIDProperties id{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES};
    VkPhysicalDeviceProperties2 props{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2}; props.pNext=&id;
    vkGetPhysicalDeviceProperties2(physical,&props);
    if (!id.deviceLUIDValid) throw std::runtime_error("Vulkan device has no valid LUID");
    ComPtr<IDXGIFactory1> factory; checkHR(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
    ComPtr<IDXGIAdapter1> matched;
    for (UINT i=0;;++i) {
        ComPtr<IDXGIAdapter1> adapter; auto result=factory->EnumAdapters1(i,&adapter);
        if (result==DXGI_ERROR_NOT_FOUND) break;
        checkHR(result);
        DXGI_ADAPTER_DESC1 desc{}; checkHR(adapter->GetDesc1(&desc));
        if (!std::memcmp(&desc.AdapterLuid,id.deviceLUID,8)) { matched=adapter; break; }
    }
    if (!matched) throw std::runtime_error("No DXGI adapter matching Vulkan LUID");
    checkHR(D3D11CreateDevice(matched.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&d3d,nullptr,nullptr));
    target=OpenProcess(PROCESS_DUP_HANDLE,FALSE,pid);
    if (!target) throw std::runtime_error("Cannot open fixed broker process for handle duplication");
}
SharedSurface::~SharedSurface() { clear(); if (target) CloseHandle(target); }
void SharedSurface::clear() {
    for (size_t i=0;i<images.size();++i) {
        if (images[i]) vkDestroyImage(device,images[i],nullptr); images[i]={};
        if (memory[i]) vkFreeMemory(device,memory[i],nullptr); memory[i]={};
        textures[i].Reset();
        if (handles[i]) {
            HANDLE local{};
            if (DuplicateHandle(target,reinterpret_cast<HANDLE>(handles[i]),GetCurrentProcess(),&local,0,FALSE,DUPLICATE_SAME_ACCESS|DUPLICATE_CLOSE_SOURCE)) CloseHandle(local);
            handles[i]=0;
        }
    }
}
void SharedSurface::create(uint32_t width, uint32_t height) {
    clear();
    VkPhysicalDeviceExternalImageFormatInfo external{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO}; external.handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT;
    VkPhysicalDeviceImageFormatInfo2 info{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2}; info.pNext=&external; info.format=VK_FORMAT_R8G8B8A8_UNORM; info.type=VK_IMAGE_TYPE_2D; info.tiling=VK_IMAGE_TILING_OPTIMAL; info.usage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    VkExternalImageFormatProperties properties{VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES};
    VkImageFormatProperties2 result{VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2}; result.pNext=&properties;
    check(vkGetPhysicalDeviceImageFormatProperties2(physical,&info,&result));
    if (!(properties.externalMemoryProperties.externalMemoryFeatures&VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT)) throw std::runtime_error("D3D11_TEXTURE color attachment import unsupported");
    for (size_t i=0;i<images.size();++i) {
        D3D11_TEXTURE2D_DESC desc{}; desc.Width=width; desc.Height=height; desc.MipLevels=1; desc.ArraySize=1; desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count=1;
        desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE; desc.MiscFlags=D3D11_RESOURCE_MISC_SHARED_NTHANDLE|D3D11_RESOURCE_MISC_SHARED;
        checkHR(d3d->CreateTexture2D(&desc,nullptr,&textures[i]));
        ComPtr<IDXGIResource1> resource; checkHR(textures[i].As(&resource));
        HANDLE handle{}; checkHR(resource->CreateSharedHandle(nullptr,DXGI_SHARED_RESOURCE_READ|DXGI_SHARED_RESOURCE_WRITE,nullptr,&handle));
        struct Close { HANDLE handle; ~Close(){CloseHandle(handle);} } close{handle};
        VkExternalMemoryImageCreateInfo ei{VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO}; ei.handleTypes=VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT;
        VkImageCreateInfo ic{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO}; ic.pNext=&ei; ic.imageType=VK_IMAGE_TYPE_2D; ic.format=VK_FORMAT_R8G8B8A8_UNORM; ic.extent={width,height,1}; ic.mipLevels=1; ic.arrayLayers=1; ic.samples=VK_SAMPLE_COUNT_1_BIT; ic.tiling=VK_IMAGE_TILING_OPTIMAL; ic.usage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
        check(vkCreateImage(device,&ic,nullptr,&images[i]));
        VkMemoryRequirements req{}; vkGetImageMemoryRequirements(device,images[i],&req);
        VkMemoryWin32HandlePropertiesKHR hp{VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR};
        auto get=reinterpret_cast<PFN_vkGetMemoryWin32HandlePropertiesKHR>(vkGetDeviceProcAddr(device,"vkGetMemoryWin32HandlePropertiesKHR"));
        check(get(device,VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,handle,&hp));
        uint32_t bits=req.memoryTypeBits&hp.memoryTypeBits;
        if (!bits) throw std::runtime_error("No compatible external memory type");
        uint32_t type=0; while (!(bits&(1u<<type))) ++type;
        VkMemoryDedicatedAllocateInfo dedicated{VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO}; dedicated.image=images[i];
        VkImportMemoryWin32HandleInfoKHR wi{VK_STRUCTURE_TYPE_IMPORT_MEMORY_WIN32_HANDLE_INFO_KHR}; wi.pNext=&dedicated; wi.handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT; wi.handle=handle;
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; allocation.pNext=&wi; allocation.allocationSize=req.size; allocation.memoryTypeIndex=type;
        check(vkAllocateMemory(device,&allocation,nullptr,&memory[i])); check(vkBindImageMemory(device,images[i],memory[i],0));
        HANDLE remote{};
        if (!DuplicateHandle(GetCurrentProcess(),handle,target,&remote,0,FALSE,DUPLICATE_SAME_ACCESS)) throw std::runtime_error("Duplicate texture handle failed");
        handles[i]=reinterpret_cast<uint64_t>(remote);
    }
}
