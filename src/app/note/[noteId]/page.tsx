"use client";

import { use } from "react";
import { useEffect, useRef, useState } from "react";
import * as yorkie from "@yorkie-js/sdk";

const RPC_ADDR = "http://localhost:8085"
const HARDCODED_YORKIE_TOKEN = ""
type DocType = { content?: yorkie.Text };
type Presence = { name: string; color: string };
type RoleType = "OWNER" | "WRITER" | "READER";

export default function NotePage({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  const { noteId } = use(params);

  const [role] = useState<RoleType>("WRITER");
  const [status, setStatus] = useState("Yorkie 로딩 준비됨");
  const [error, setError] = useState("");
  const [initialContentLoaded, setInitialContentLoaded] = useState(false);

  const dockey = `note-${noteId}`;

  const clientRef = useRef<yorkie.Client | null>(null);
  const docRef = useRef<yorkie.Document<DocType, Presence> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {

    (async () => {
      try {
        setStatus("Yorkie 연결 중...");

        const client = new yorkie.Client({
          rpcAddr: RPC_ADDR,
          authTokenInjector: async () => {
            return HARDCODED_YORKIE_TOKEN;
          },
        });

        await client.activate();
        clientRef.current = client;
        setStatus("Client 활성화 완료");

        const doc = new yorkie.Document<DocType, Presence>(dockey);
        await client.attach(doc);
        docRef.current = doc;

        doc.update((root) => {
          if (!root.content) root.content = new yorkie.Text();
          const text = root.content.toString();
          if (textareaRef.current && textareaRef.current.value !== text) {
            textareaRef.current.value = text;
          }
        });
        setInitialContentLoaded(true);

        doc.subscribe((event: any) => {
          if (event.type === "remote-change") {
            const text = doc.getRoot().content?.toString() ?? "";
            if (textareaRef.current) textareaRef.current.value = text;
          }
        });

        doc.subscribe("sync", (e: any) => {
          setStatus(`Sync: ${e.value}`);
        });
        doc.subscribe("auth-error", (e: any) => {
          const msg = `Auth Error: method=${e.value.method}, reason=${e.value.reason}. 하드코딩된 토큰이 유효하지 않을 수 있습니다.`;
          setError(msg);
          setStatus("인증 오류 발생");
        });

        setStatus("편집 준비 완료 (Yorkie 전용 테스트 모드)");
      } catch (e: any) {
        setError(String(e?.message ?? e));
        setStatus("Yorkie 연결 실패");
      }
    })();

    return () => {
      (async () => {
        try {
          if (docRef.current && clientRef.current) {
            await clientRef.current.detach(docRef.current);
          }
          if (clientRef.current) {
            await clientRef.current.deactivate();
          }
        } catch (e: any) {
        }
      })();
    };
  }, [dockey]);

  // ───────────────────────────────────────────────────────────────
  // 3) 입력 핸들러
  const onInput = () => {
    if (!docRef.current || role === "READER") return;
    const value = textareaRef.current?.value ?? "";
    docRef.current.update((root) => {
      if (!root.content) root.content = new yorkie.Text();
      root.content!.edit(0, root.content!.length, value);
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-10 px-6">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow p-6 space-y-5 border border-gray-200">
        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-indigo-600">
            📄 Note #{noteId}
          </h1>
          <span className="text-sm text-gray-500">
            dockey: <code>{dockey}</code>
          </span>
        </div>

        {/* 상태 뱃지 */}
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full font-medium">
            status: {status}
          </span>
          <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full">
            {status}         
          </span>
        </div>

        {/* 에러 표시 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 p-3 rounded-md">
            {error}
          </div>
        )}

        <div className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-700 p-3 rounded-md">
          **주의**: `HARDCODED_YORKIE_TOKEN` 변수에 유효한 토큰을 입력해야 합니다.
        </div>

        {/* 에디터 */}
        <textarea
          ref={textareaRef}
          onInput={onInput}
          disabled={role === "READER" || !initialContentLoaded}
          placeholder={
            !initialContentLoaded ? "문서 로딩 중..." :
              role === "READER" ? "읽기 전용 모드입니다." : "내용을 입력하세요..."
          }
          className="w-full h-72 resize-none border border-gray-300 rounded-lg p-4 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
        />

        <p className="text-xs text-gray-500">
          Yorkie 클라이언트 테스트
        </p>
      </div>
    </div>
  );
}
