#include "camera.h"
#include "vulkan_renderer.h"
#include <algorithm>
#include <chrono>
#include <deque>
#include <iostream>
#include <mutex>
#include <nlohmann/json.hpp>
#include <thread>

int sharedWorker(uint32_t brokerPid, bool validation) {
    wchar_t executable[32768]{}; GetModuleFileNameW(nullptr,executable,32768);
    VulkanRenderer renderer(nullptr,validation,std::filesystem::path(executable).parent_path()/"shaders",brokerPid);
    Camera camera;
    std::cout << nlohmann::json({{"type","hello"},{"protocol",2},{"transport","d3d11-nt-rgba8"},
      {"extensions",{"graphics101.camera.v1"}},{"backend","vulkan"},{"vendorId",renderer.gpuVendor},
      {"deviceId",renderer.gpuDevice},{"gpu",renderer.gpuName},{"runtimeCpuReadbacks",0},{"exportGpuCopies",0}}).dump() << '\n' << std::flush;
    std::mutex mutex;
    std::deque<std::string> commands;
    bool eof=false;
    std::thread reader([&] {
        std::string line;
        while (std::getline(std::cin,line)) {
            { std::lock_guard lock(mutex); commands.push_back(line); }
            if (line=="{\"kind\":\"stop\"}") return;
        }
        std::lock_guard lock(mutex); eof=true;
    });
    struct Join {
        std::thread& thread;
        ~Join() { if (thread.joinable()) { CancelSynchronousIo(thread.native_handle()); thread.join(); } }
    } join{reader};
    uint32_t width=0,height=0,pendingWidth=0,pendingHeight=0;
    uint64_t epoch=0,frameId=0,inputSeq=0;
    std::array<uint64_t,4> leased{};
    std::array<std::chrono::steady_clock::time_point,4> offered{};
    bool visible=true, running=true, dragging=false;
    double pointerX=0,pointerY=0;
    uint64_t pointerId=0;
    auto previous=std::chrono::steady_clock::now(), lastStats=previous, nextFrame=previous;
    while (running) {
            std::deque<std::string> batch;
            { std::lock_guard lock(mutex); batch.swap(commands); if (eof) running=false; }
            for (auto& line:batch) {
                if (line.size()>16384) throw std::runtime_error("Viewport message limit exceeded");
                auto message=nlohmann::json::parse(line);
                auto kind=message.at("kind").get<std::string>();
                if (kind=="stop") { running=false; break; }
                if (kind=="resize") { pendingWidth=message.at("width"); pendingHeight=message.at("height"); }
                else if (kind=="visible") {
                    visible=message.at("value");
                    if (!visible) { camera.focusLost(); dragging=false; }
                } else if (kind=="release") {
                    uint64_t e=message.at("epoch"),id=message.at("frameId"); uint32_t slot=message.at("slot");
                    if (e==epoch && slot<4 && leased[slot]==id) leased[slot]=0;
                } else if (kind=="input" || kind=="extension") {
                    uint64_t seq=message.at("seq");
                    if (seq<=inputSeq) continue;
                    if (kind=="extension") {
                        if (message.at("namespace")!="graphics101.camera.v1") throw std::runtime_error("Unsupported extension");
                        auto name=message.at("name").get<std::string>();
                        if (name=="reset") camera.reset();
                        else if (name=="rotate") camera.rotating=message.at("payload").at("value");
                        else throw std::runtime_error("Unsupported camera operation");
                    } else {
                        const auto& event=message.at("event");
                        auto type=event.at("type").get<std::string>();
                        if (type=="focus") { if (!event.at("focused").get<bool>()) { camera.focusLost(); dragging=false; } }
                        else if (type=="wheel") camera.dolly(std::clamp(-event.at("deltaY").get<float>()/100,-10.0f,10.0f));
                        else if (type=="key") {
                            auto code=event.at("code").get<std::string>();
                            unsigned key=code=="Space"?32:code.size()==4 && code.starts_with("Key")?static_cast<unsigned>(code[3]):0;
                            if (key && !event.at("repeat").get<bool>()) camera.key(key,event.at("down"));
                        } else if (type=="pointer") {
                            auto phase=event.at("phase").get<std::string>();
                            uint64_t id=event.at("pointerId");
                            double x=event.at("x"),y=event.at("y");
                            if (phase=="down" && event.at("button")==0 && !dragging) { dragging=true; pointerId=id; }
                            else if (dragging && id==pointerId) {
                                if (phase=="move") camera.orbit(static_cast<float>(x-pointerX),static_cast<float>(y-pointerY));
                                else dragging=false;
                            }
                            if (id==pointerId) { pointerX=x; pointerY=y; }
                        } else throw std::runtime_error("Unsupported input event");
                    }
                    inputSeq=seq;
                } else throw std::runtime_error("Unsupported viewport command");
            }
            if (!running) break;
            auto now=std::chrono::steady_clock::now();
            bool allFree=true;
            for (size_t slot=0;slot<4;++slot) if (leased[slot]) {
                allFree=false;
                if (now-offered[slot]>std::chrono::seconds(10)) throw std::runtime_error("Lease timeout: stopping without slot reuse");
            }
            if (pendingWidth && pendingHeight && (pendingWidth!=width || pendingHeight!=height) && allFree) {
                if (pendingWidth>2048 || pendingHeight>2048) throw std::runtime_error("Viewport quota exceeded");
                width=pendingWidth; height=pendingHeight; renderer.sharedResize(width,height); ++epoch;
                std::cout << "{\"type\":\"surface\",\"epoch\":" << epoch << ",\"width\":" << width << ",\"height\":" << height << ",\"slots\":4}\n" << std::flush;
            }
            camera.update(std::chrono::duration<float>(now-previous).count()); previous=now;
            if (visible && width && pendingWidth==width && pendingHeight==height && now>=nextFrame) {
                for (uint32_t slot=0;slot<4;++slot) if (!leased[slot]) {
                    renderer.sharedDraw(camera.matrix(static_cast<float>(width)/height),slot);
                    leased[slot]=++frameId; offered[slot]=std::chrono::steady_clock::now();
                    auto us=std::chrono::duration_cast<std::chrono::microseconds>(offered[slot].time_since_epoch()).count();
                    std::cout << "{\"type\":\"frame\",\"epoch\":" << epoch << ",\"slot\":" << slot << ",\"frameId\":" << frameId
                      << ",\"width\":" << width << ",\"height\":" << height << ",\"inputSeq\":" << inputSeq << ",\"timestampUs\":" << us << ",\"handle\":\"" << renderer.sharedHandle(slot) << "\"}\n" << std::flush;
                    break;
                }
                nextFrame=now+std::chrono::microseconds(16667);
            }
            if (now-lastStats>=std::chrono::seconds(1)) {
                std::cout << "{\"type\":\"stats\",\"frames\":" << frameId << ",\"inputSeq\":" << inputSeq << ",\"validationErrors\":" << renderer.validationErrors.load() << "}\n" << std::flush;
                lastStats=now;
            }
            Sleep(1);
        }
        if (reader.joinable()) { CancelSynchronousIo(reader.native_handle()); reader.join(); }
        renderer.finish();
        std::cout << "{\"type\":\"stopped\",\"frames\":" << frameId << ",\"validationErrors\":" << renderer.validationErrors.load() << "}\n" << std::flush;
        return renderer.validationErrors?1:0;
}

