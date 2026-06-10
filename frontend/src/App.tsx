import { ConfigProvider, App as AntdApp } from "antd";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";

export function App() {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#2563eb",
          borderRadius: 6,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        },
        components: {
          Card: {
            borderRadiusLG: 6,
          },
          Button: {
            borderRadius: 6,
          },
        },
      }}
    >
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  );
}
