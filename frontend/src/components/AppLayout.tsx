import { CodeOutlined, PlusOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Layout, Menu, Typography } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

const { Header, Content } = Layout;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const selectedKey = location.pathname.startsWith("/tasks/create") ? "/tasks/create" : "/tasks";

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="brand" onClick={() => navigate("/tasks")} role="button" tabIndex={0}>
          <CodeOutlined />
          <Typography.Text strong>Mini Coding Agent</Typography.Text>
        </div>
        <Menu
          mode="horizontal"
          selectedKeys={[selectedKey]}
          className="top-menu"
          onClick={(item) => navigate(item.key)}
          items={[
            { key: "/tasks", icon: <UnorderedListOutlined />, label: "Tasks" },
            { key: "/tasks/create", icon: <PlusOutlined />, label: "Create" },
          ]}
        />
      </Header>
      <Content className="app-content">
        <Outlet />
      </Content>
    </Layout>
  );
}
