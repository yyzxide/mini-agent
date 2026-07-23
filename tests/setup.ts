import { setFetchUrlTransportForTesting } from "../src/tools/FetchUrlTool.js";

setFetchUrlTransportForTesting(async (url, signal) => await fetch(url, {
  method: "GET",
  redirect: "manual",
  signal,
  headers: {
    "accept": "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
    "user-agent": "mini-coding-agent/0.1",
  },
}));
