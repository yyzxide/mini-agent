import axios, { AxiosError } from "axios";

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string | null;
}

const defaultBaseUrl = "http://localhost:8080";

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || defaultBaseUrl;

export const http = axios.create({
  baseURL: apiBaseUrl,
  timeout: 30000,
});

http.interceptors.response.use(
  (response) => {
    const body = response.data as ApiResponse<unknown> | unknown;
    if (isApiResponse(body)) {
      if (!body.success) {
        return Promise.reject(new Error(body.error || "Request failed"));
      }
      response.data = body.data;
    }
    return response;
  },
  (error: AxiosError<{ error?: string; message?: string }>) => {
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      "Network request failed";
    return Promise.reject(new Error(message));
  },
);

function isApiResponse(value: unknown): value is ApiResponse<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    "data" in value
  );
}
