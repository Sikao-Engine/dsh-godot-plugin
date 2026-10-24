#include <vulkan/vulkan.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace {
void check(VkResult r) { if (r!=VK_SUCCESS) throw std::runtime_error("Vulkan probe error " + std::to_string(r)); }
std::string luid(const void* data) {
    auto bytes=static_cast<const unsigned char*>(data);
    std::ostringstream out;
    for (int i=0;i<8;++i) out << std::hex << std::setfill('0') << std::setw(2) << unsigned(bytes[i]);
    return out.str();
}
std::string quoted(const char* value) {
    std::string out="\"";
    for (;*value;++value) { if (*value=='"' || *value=='\\') out+='\\'; out+=*value; }
    return out+'"';
}
}
int interopProbe() {
    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO}; app.apiVersion=VK_API_VERSION_1_1;
    VkInstanceCreateInfo create{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO}; create.pApplicationInfo=&app;
    VkInstance instance{}; check(vkCreateInstance(&create,nullptr,&instance));
    struct Cleanup { VkInstance instance; ~Cleanup(){vkDestroyInstance(instance,nullptr);} } cleanup{instance};
    uint32_t count=0; check(vkEnumeratePhysicalDevices(instance,&count,nullptr));
    std::vector<VkPhysicalDevice> devices(count); check(vkEnumeratePhysicalDevices(instance,&count,devices.data()));
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) throw std::runtime_error("CreateDXGIFactory1 failed");
    std::cout << "{\"probeVersion\":1,\"chromiumLuid\":null,\"displayGate\":\"not-tested\",\"devices\":[";
    bool first=true;
    for (auto physical:devices) {
        VkPhysicalDeviceIDProperties id{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES};
        VkPhysicalDeviceProperties2 props{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2}; props.pNext=&id;
        vkGetPhysicalDeviceProperties2(physical,&props);
        uint32_t extensionCount=0; check(vkEnumerateDeviceExtensionProperties(physical,nullptr,&extensionCount,nullptr));
        std::vector<VkExtensionProperties> extensions(extensionCount);
        check(vkEnumerateDeviceExtensionProperties(physical,nullptr,&extensionCount,extensions.data()));
        bool external=false;
        for (auto& e:extensions) if (!std::strcmp(e.extensionName,VK_KHR_EXTERNAL_MEMORY_WIN32_EXTENSION_NAME)) external=true;
        if (!first) std::cout << ',';
        first=false;
        std::cout << "{\"name\":" << quoted(props.properties.deviceName) << ",\"apiVersion\":" << props.properties.apiVersion
          << ",\"driverVersion\":" << props.properties.driverVersion << ",\"deviceType\":" << props.properties.deviceType
          << ",\"luidValid\":" << (id.deviceLUIDValid?"true":"false") << ",\"luid\":\"" << luid(id.deviceLUID)
          << "\",\"externalMemoryWin32\":" << (external?"true":"false");
        ComPtr<IDXGIAdapter1> matched;
        for (UINT i=0;;++i) {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory->EnumAdapters1(i,&adapter)==DXGI_ERROR_NOT_FOUND) break;
            DXGI_ADAPTER_DESC1 desc{}; adapter->GetDesc1(&desc);
            if (id.deviceLUIDValid && !std::memcmp(&desc.AdapterLuid,id.deviceLUID,8)) { matched=adapter; break; }
        }
        HRESULT textureResult=E_FAIL, handleResult=E_FAIL;
        ComPtr<ID3D11Device> d3d; ComPtr<ID3D11DeviceContext> context; ComPtr<ID3D11Texture2D> texture; HANDLE handle=nullptr;
        if (matched) {
            D3D_FEATURE_LEVEL level{};
            textureResult=D3D11CreateDevice(matched.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&d3d,&level,&context);
            if (SUCCEEDED(textureResult)) {
                D3D11_TEXTURE2D_DESC desc{}; desc.Width=64; desc.Height=64; desc.MipLevels=1; desc.ArraySize=1;
                desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count=1; desc.Usage=D3D11_USAGE_DEFAULT;
                desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE; desc.MiscFlags=D3D11_RESOURCE_MISC_SHARED_NTHANDLE|D3D11_RESOURCE_MISC_SHARED;
                textureResult=d3d->CreateTexture2D(&desc,nullptr,&texture);
                if (SUCCEEDED(textureResult)) {
                    ComPtr<IDXGIResource1> resource;
                    handleResult=texture.As(&resource);
                    if (SUCCEEDED(handleResult)) handleResult=resource->CreateSharedHandle(nullptr,DXGI_SHARED_RESOURCE_READ|DXGI_SHARED_RESOURCE_WRITE,nullptr,&handle);
                }
            }
        }
        std::cout << ",\"dxgiMatched\":" << (matched?"true":"false") << ",\"d3d11TextureHresult\":" << static_cast<int32_t>(textureResult)
          << ",\"ntHandleHresult\":" << static_cast<int32_t>(handleResult) << ",\"formats\":[";
        bool firstFormat=true;
        for (auto format:{VK_FORMAT_R8G8B8A8_UNORM,VK_FORMAT_B8G8R8A8_UNORM}) {
            for (VkImageUsageFlags usage:{VkImageUsageFlags(VK_IMAGE_USAGE_TRANSFER_DST_BIT),VkImageUsageFlags(VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT|VK_IMAGE_USAGE_TRANSFER_DST_BIT)}) {
                VkPhysicalDeviceExternalImageFormatInfo externalInfo{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO};
                externalInfo.handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT;
                VkPhysicalDeviceImageFormatInfo2 info{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2}; info.pNext=&externalInfo;
                info.format=format; info.type=VK_IMAGE_TYPE_2D; info.tiling=VK_IMAGE_TILING_OPTIMAL; info.usage=usage;
                VkExternalImageFormatProperties externalProps{VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES};
                VkImageFormatProperties2 result{VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2}; result.pNext=&externalProps;
                VkResult status=vkGetPhysicalDeviceImageFormatProperties2(physical,&info,&result);
                auto features=externalProps.externalMemoryProperties.externalMemoryFeatures;
                if (!firstFormat) std::cout << ','; firstFormat=false;
                std::cout << "{\"format\":" << format << ",\"usage\":" << usage << ",\"tiling\":\"optimal\",\"result\":" << status
                  << ",\"importable\":" << ((features&VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT)?"true":"false")
                  << ",\"dedicatedOnly\":" << ((features&VK_EXTERNAL_MEMORY_FEATURE_DEDICATED_ONLY_BIT)?"true":"false")
                  << ",\"compatibleHandleTypes\":" << externalProps.externalMemoryProperties.compatibleHandleTypes;
                VkResult importResult=VK_ERROR_FORMAT_NOT_SUPPORTED; uint32_t memoryBits=0;
                VkDevice device{}; VkImage image{}; VkDeviceMemory memory{};
                if (external && handle && status==VK_SUCCESS && (features&VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT) && format==VK_FORMAT_R8G8B8A8_UNORM) {
                    uint32_t queueCount=0; vkGetPhysicalDeviceQueueFamilyProperties(physical,&queueCount,nullptr);
                    std::vector<VkQueueFamilyProperties> queues(queueCount); vkGetPhysicalDeviceQueueFamilyProperties(physical,&queueCount,queues.data());
                    uint32_t family=0; while (family<queueCount && !(queues[family].queueFlags&VK_QUEUE_GRAPHICS_BIT)) ++family;
                    float priority=1; VkDeviceQueueCreateInfo queue{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO}; queue.queueFamilyIndex=family; queue.queueCount=1; queue.pQueuePriorities=&priority;
                    const char* names[]={VK_KHR_EXTERNAL_MEMORY_WIN32_EXTENSION_NAME};
                    VkDeviceCreateInfo dc{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO}; dc.queueCreateInfoCount=1; dc.pQueueCreateInfos=&queue; dc.enabledExtensionCount=1; dc.ppEnabledExtensionNames=names;
                    importResult=vkCreateDevice(physical,&dc,nullptr,&device);
                    if (importResult==VK_SUCCESS) {
                        VkExternalMemoryImageCreateInfo ei{VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO}; ei.handleTypes=VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT;
                        VkImageCreateInfo ic{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO}; ic.pNext=&ei; ic.imageType=VK_IMAGE_TYPE_2D; ic.format=format; ic.extent={64,64,1}; ic.mipLevels=1; ic.arrayLayers=1; ic.samples=VK_SAMPLE_COUNT_1_BIT; ic.tiling=VK_IMAGE_TILING_OPTIMAL; ic.usage=usage;
                        importResult=vkCreateImage(device,&ic,nullptr,&image);
                        if (importResult==VK_SUCCESS) {
                            VkMemoryRequirements requirements{}; vkGetImageMemoryRequirements(device,image,&requirements);
                            VkMemoryWin32HandlePropertiesKHR hp{VK_STRUCTURE_TYPE_MEMORY_WIN32_HANDLE_PROPERTIES_KHR};
                            auto get=reinterpret_cast<PFN_vkGetMemoryWin32HandlePropertiesKHR>(vkGetDeviceProcAddr(device,"vkGetMemoryWin32HandlePropertiesKHR"));
                            importResult=get(device,VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT,handle,&hp);
                            memoryBits=hp.memoryTypeBits&requirements.memoryTypeBits;
                            if (importResult==VK_SUCCESS && memoryBits) {
                                uint32_t type=0; while (!(memoryBits&(1u<<type))) ++type;
                                VkMemoryDedicatedAllocateInfo dedicated{VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO}; dedicated.image=image;
                                VkImportMemoryWin32HandleInfoKHR wi{VK_STRUCTURE_TYPE_IMPORT_MEMORY_WIN32_HANDLE_INFO_KHR}; wi.pNext=&dedicated; wi.handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_D3D11_TEXTURE_BIT; wi.handle=handle;
                                VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; allocation.pNext=&wi; allocation.allocationSize=requirements.size; allocation.memoryTypeIndex=type;
                                importResult=vkAllocateMemory(device,&allocation,nullptr,&memory);
                                if (importResult==VK_SUCCESS) importResult=vkBindImageMemory(device,image,memory,0);
                            } else if (importResult==VK_SUCCESS) importResult=VK_ERROR_FEATURE_NOT_PRESENT;
                        }
                    }
                }
                std::cout << ",\"memoryTypeBits\":" << memoryBits << ",\"importAttempted\":" << (device?"true":"false") << ",\"importBindResult\":";
                if (device) std::cout << importResult; else std::cout << "null";
                std::cout << '}';
                if (image) vkDestroyImage(device,image,nullptr);
                if (memory) vkFreeMemory(device,memory,nullptr);
                if (device) vkDestroyDevice(device,nullptr);
            }
        }
        if (handle) CloseHandle(handle);
        std::cout << "]}";
    }
    std::cout << "]}\n";
    return count?0:1;
}
