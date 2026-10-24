#include "camera.h"
#include "vulkan_renderer.h"
#include <windowsx.h>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

int interopProbe();
int sharedWorker(uint32_t brokerPid, bool validation);
namespace {
struct App {
    Camera camera;
    VulkanRenderer* renderer=nullptr;
    bool dragging=false;
    POINT pointer{};
};
LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto app=reinterpret_cast<App*>(GetWindowLongPtrW(window,GWLP_USERDATA));
    if (message==WM_NCCREATE) { app=static_cast<App*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams); SetWindowLongPtrW(window,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(app)); }
    if (!app) return DefWindowProcW(window,message,w,l);
    switch (message) {
    case WM_SIZE: if (app->renderer) app->renderer->resize(); return 0;
    case WM_LBUTTONDOWN: app->dragging=true; app->pointer={GET_X_LPARAM(l),GET_Y_LPARAM(l)}; SetCapture(window); return 0;
    case WM_MOUSEMOVE:
        if (app->dragging) {
            POINT next{GET_X_LPARAM(l),GET_Y_LPARAM(l)};
            app->camera.orbit(static_cast<float>(next.x-app->pointer.x),static_cast<float>(next.y-app->pointer.y)); app->pointer=next;
        }
        return 0;
    case WM_LBUTTONUP: app->dragging=false; ReleaseCapture(); return 0;
    case WM_CAPTURECHANGED: app->dragging=false; return 0;
    case WM_CANCELMODE: app->dragging=false; ReleaseCapture(); return 0;
    case WM_MOUSEWHEEL: app->camera.dolly(static_cast<float>(GET_WHEEL_DELTA_WPARAM(w))/WHEEL_DELTA); return 0;
    case WM_KEYDOWN: case WM_KEYUP: app->camera.key(static_cast<unsigned>(w),message==WM_KEYDOWN); return 0;
    case WM_KILLFOCUS: app->camera.focusLost(); app->dragging=false; ReleaseCapture(); return 0;
    case WM_CLOSE: DestroyWindow(window); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    default: return DefWindowProcW(window,message,w,l);
    }
}
}
int main(int argc, char** argv) {
    try {
        bool validation=false, smoke=false, shared=false; uint64_t limit=0; uint32_t brokerPid=0;
        for (int i=1;i<argc;++i) {
            std::string arg=argv[i];
            if (arg=="--probe") return interopProbe();
            if (arg=="--camera-test") return cameraTest();
            if (arg=="--validation") validation=true;
            else if (arg=="--smoke") smoke=true;
            else if (arg=="--shared-output") shared=true;
            else if (arg=="--dsh-viewport-protocol" && i+1<argc) {
                if (std::string(argv[++i])!="2") throw std::runtime_error("Unsupported viewport protocol");
                shared=true;
            }
            else if (arg=="--broker-pid" && i+1<argc) brokerPid=static_cast<uint32_t>(std::stoul(argv[++i]));
            else if (arg=="--frames" && i+1<argc) limit=std::stoull(argv[++i]);
            else throw std::runtime_error("Unknown or incomplete argument: "+arg);
        }
        if (shared) {
            if (!brokerPid) throw std::runtime_error("Shared output requires fixed broker PID");
            return sharedWorker(brokerPid,validation);
        }
        if (smoke && !limit) limit=180;
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        App app;
        if (smoke) app.camera.rotating=false;
        WNDCLASSW cls{}; cls.lpfnWndProc=windowProc; cls.hInstance=GetModuleHandleW(nullptr); cls.lpszClassName=L"Graphics101"; cls.hCursor=LoadCursorW(nullptr,IDC_ARROW);
        if (!RegisterClassW(&cls)) throw std::runtime_error("RegisterClass failed");
        HWND window=CreateWindowExW(0,cls.lpszClassName,L"Graphics101 | Vulkan standalone | drag / wheel / WASD / QE / R / Space",WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,960,640,nullptr,nullptr,cls.hInstance,&app);
        if (!window) throw std::runtime_error("CreateWindow failed");
        struct WindowCleanup { HWND window; ~WindowCleanup(){if(IsWindow(window)) DestroyWindow(window);} } windowCleanup{window};
        wchar_t executable[32768]{}; GetModuleFileNameW(nullptr,executable,32768);
        VulkanRenderer renderer(window,validation,std::filesystem::path(executable).parent_path()/"shaders"); app.renderer=&renderer;
        ShowWindow(window,SW_SHOW);
        auto previous=std::chrono::steady_clock::now();
        uint64_t smokeStep=0, matrixChanges=0;
        auto oldMatrix=app.camera.matrix(1);
        bool running=true;
        while (running && (!limit || renderer.frames<limit)) {
            MSG message{};
            while (PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) { if (message.message==WM_QUIT) running=false; TranslateMessage(&message); DispatchMessageW(&message); }
            if (!running) break;
            if (smoke) {
                if (smokeStep==10) SendMessageW(window,WM_LBUTTONDOWN,MK_LBUTTON,MAKELPARAM(100,100));
                if (smokeStep==11) SendMessageW(window,WM_MOUSEMOVE,MK_LBUTTON,MAKELPARAM(140,120));
                if (smokeStep==12) SendMessageW(window,WM_CANCELMODE,0,0);
                if (smokeStep==20) SendMessageW(window,WM_MOUSEWHEEL,MAKEWPARAM(0,WHEEL_DELTA),0);
                if (smokeStep==30) SendMessageW(window,WM_KEYDOWN,'W',0);
                if (smokeStep==40) SendMessageW(window,WM_KILLFOCUS,0,0);
                if (smokeStep==50) SendMessageW(window,WM_KEYDOWN,'R',0);
                if (smokeStep==51) SendMessageW(window,WM_KEYUP,'R',0);
                if (smokeStep>=60 && smokeStep<160) SetWindowPos(window,nullptr,0,0,640+static_cast<int>(smokeStep%7)*30,480+static_cast<int>(smokeStep%5)*20,SWP_NOMOVE|SWP_NOZORDER);
                if (smokeStep==160) ShowWindow(window,SW_MINIMIZE);
                if (smokeStep==162) ShowWindow(window,SW_RESTORE);
                ++smokeStep;
            }
            auto now=std::chrono::steady_clock::now(); app.camera.update(std::chrono::duration<float>(now-previous).count()); previous=now;
            RECT rect{}; GetClientRect(window,&rect);
            if (rect.bottom>0) {
                auto matrix=app.camera.matrix(static_cast<float>(rect.right)/static_cast<float>(rect.bottom));
                if (matrix!=oldMatrix) ++matrixChanges;
                oldMatrix=matrix;
                if (!renderer.draw(matrix)) Sleep(10);
            } else Sleep(10);
        }
        app.renderer=nullptr;
        renderer.finish();
        std::cout << "{\"backend\":\"vulkan-standalone\",\"frames\":" << renderer.frames << ",\"inputSeq\":" << app.camera.inputSeq
          << ",\"matrixChanges\":" << matrixChanges << ",\"validationErrors\":" << renderer.validationErrors.load() << ",\"runtimeCpuReadbacks\":0,\"exportGpuCopies\":0,\"sharedOutput\":false}\n";
        return renderer.validationErrors || (smoke && (!matrixChanges || renderer.frames!=limit)) ? 1 : 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
