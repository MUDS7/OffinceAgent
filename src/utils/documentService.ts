import { invoke } from "@tauri-apps/api/core";
import type { ServiceStatus } from "../types";
import { canUseTauriEvents, isTauriUnavailable } from "./tauriUtils";

type RequestInitFactory = RequestInit | (() => RequestInit);

export async function fetchDocumentService(
  url: string,
  init?: RequestInitFactory,
): Promise<Response> {
  try {
    return await fetch(url, getRequestInit(init));
  } catch (error) {
    if (!canUseTauriEvents()) {
      throw new Error(buildDocumentServiceUnavailableMessage(error));
    }

    let status: ServiceStatus;
    try {
      status = await invoke<ServiceStatus>("restart_document_service");
    } catch (restartError) {
      if (!isTauriUnavailable(String(restartError))) {
        throw new Error(
          `${buildDocumentServiceUnavailableMessage(error)}；重启文档服务失败：${
            restartError instanceof Error ? restartError.message : String(restartError)
          }`,
        );
      }

      throw new Error(buildDocumentServiceUnavailableMessage(error));
    }

    if (!status.running) {
      throw new Error(`${buildDocumentServiceUnavailableMessage(error)}；重启后文档服务仍未就绪`);
    }

    try {
      return await fetch(url, getRequestInit(init));
    } catch (retryError) {
      throw new Error(
        `${buildDocumentServiceUnavailableMessage(error)}；重启后重试仍失败：${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
      );
    }
  }
}

function getRequestInit(init?: RequestInitFactory) {
  return typeof init === "function" ? init() : init;
}

function buildDocumentServiceUnavailableMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `无法连接本地文档服务，请确认 OfficeAgent 文档服务已启动（${detail}）`;
}
