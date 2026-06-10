import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppLayout } from "../components/AppLayout";
import { TaskCreatePage } from "../pages/TaskCreatePage";
import { TaskDetailPage } from "../pages/TaskDetailPage";
import { TaskListPage } from "../pages/TaskListPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: "tasks", element: <TaskListPage /> },
      { path: "tasks/create", element: <TaskCreatePage /> },
      { path: "tasks/:id", element: <TaskDetailPage /> },
    ],
  },
]);
