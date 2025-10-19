// app/note/[noteId]/page.tsx
"use client";

import { use } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as yorkie from "@yorkie-js/sdk";

// ==== env (빌드 시 주입) ====
const ENV_RPC = process.env.NEXT_PUBLIC_YORKIE_RPC_ADDR as string | undefined;
const API_KEY = process.env.NEXT_PUBLIC_YORKIE_API_KEY as string;
const USER_API = process.env.NEXT_PUBLIC_USER_API as string;

// ---- 유틸 ----
type DocType = { content?: yorkie.Text };
type Presence = { name: string; color: string };

const short = (s?: string | null, head = 12, tail = 8) =>
  !s
    ? ""
    : s.length <= head + tail
    ? s
    : `${s.slice(0, head)}…${s.slice(-tail)}`;

const getAccessToken = () => sessionStorage.getItem("accessToken") ?? "";
const setAccessToken = (v: string) => sessionStorage.setItem("accessToken", v);
const clearAccessToken = () => sessionStorage.removeItem("accessToken");

function decodeJwtPayload(token: string): any | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(
      base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ==== 컴포넌트 ====
export default function NotePage({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  const { noteId } = use(params);

  const [rpcAddr, setRpcAddr] = useState<string>("");
  const [role, setRole] = useState<"OWNER" | "WRITER" | "READER" | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const [debug, setDebug] = useState<string[]>([]);
  const [tokenPreview, setTokenPreview] = useState<string>("");

  const [permApi, setPermApi] = useState<{
    ok?: boolean;
    status?: number;
    at?: string;
  }>({});
  const [tokenApi, setTokenApi] = useState<{
    ok?: boolean;
    status?: number;
    at?: string;
    expiresIn?: number;
    attrKey?: string;
    attrVerb?: string;
  }>({});
  const [attachState, setAttachState] = useState<{
    attached?: boolean;
    sync?: string;
    authError?: string;
    at?: string;
  }>({});

  const [yorkieToken, setYorkieToken] = useState<string>("");
  const [yorkieClaims, setYorkieClaims] = useState<any>(null);
  const [tokenTimeLeft, setTokenTimeLeft] = useState<number | null>(null);

  const dockey = useMemo(() => `note-${noteId}`, [noteId]);

  const clientRef = useRef<yorkie.Client | null>(null);
  const docRef = useRef<yorkie.Document<DocType, Presence> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const nowStr = () => new Date().toLocaleTimeString();
  const log = (m: string) =>
    setDebug((prev) => [`[${nowStr()}] ${m}`, ...prev]);

  // 0) env → rpcAddr 결정 (쿼리스트링 rpc= 로 덮어쓰기 가능)
  useEffect(() => {
    const qs =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const override = qs?.get("rpc") || "";
    const finalRpc = override || ENV_RPC || "https://api.yorkie.dev";
    setRpcAddr(finalRpc);
    console.info(
      "[Yorkie] rpcAddr =",
      finalRpc,
      "| apiKey set? =",
      Boolean(API_KEY),
      "| USER_API =",
      USER_API
    );
  }, []);

  // 0-1) 세션 토큰 프리뷰
  useEffect(() => setTokenPreview(short(getAccessToken()) || ""), []);

  const setJwt = () => {
    const el = document.getElementById(
      "dev-jwt-input"
    ) as HTMLInputElement | null;
    if (el?.value) {
      setAccessToken(el.value);
      setTokenPreview(short(el.value) || "");
      alert("세션에 JWT 저장 완료! 새로고침(F5) 하세요.");
    }
  };
  const clearJwt = () => {
    clearAccessToken();
    setTokenPreview("");
    alert("세션에서 JWT 삭제됨.");
  };

  // 1) 권한 조회
  useEffect(() => {
    (async () => {
      console.log(`[DEBUG] 1. 권한 조회 시작. noteId: ${noteId}`);
      try {
        setStatus("권한 확인 중...");
        log(`GET /permission/${noteId}/me`);
        const res = await fetch(`${USER_API}/permission/${noteId}/me`, {
          headers: { Authorization: `Bearer ${getAccessToken()}` },
        });
        log(`permission/me → ${res.status}`);
        setPermApi({ ok: res.ok, status: res.status, at: nowStr() });
        if (!res.ok) throw new Error(`permission/me failed: ${res.status}`);

        const body = await res.json();
        console.log("[DEBUG] 권한 API 본문:", body);
        const userRole = body.data?.role ?? null;
        console.log(`[DEBUG] 추출된 role: ${userRole}`);
        setRole(userRole);
        setStatus("권한 확인 완료");
      } catch (e: any) {
        console.error("[DEBUG] 권한 조회 예외!", e);
        setError(String(e?.message ?? e));
        setStatus("권한 조회 실패");
        setPermApi((p) => ({ ...p, ok: false, at: nowStr() }));
        log(`permission/me error: ${String(e)}`);
      }
    })();
  }, [noteId, USER_API]);

  // Yorkie 토큰 남은 시간 표시
  useEffect(() => {
    if (!yorkieToken) return;
    const claims = decodeJwtPayload(yorkieToken);
    setYorkieClaims(claims);
    const timer = setInterval(() => {
      if (claims?.exp) {
        const left = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
        setTokenTimeLeft(left);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [yorkieToken]);

  // 2) Yorkie client + attach
  useEffect(() => {
    console.log(
      `[DEBUG] 5. Yorkie 실행 조건 확인. role="${role}", rpcAddr="${rpcAddr}"`
    );
    if (!role) {
      if (role === null) console.warn("[DEBUG] role=null → Yorkie 로직 건너뜀");
      return;
    }
    if (!rpcAddr) return; // 아직 env 결정 전

    (async () => {
      try {
        setStatus("Yorkie 연결 중...");
        log("Yorkie Client 생성 시도");

        // 인증 토큰 인젝터: 웹훅 실패/만료 시 서버로부터 yorkie-token 재발급
        const authTokenInjector = async (reason?: string) => {
          console.log(
            `[DEBUG] authTokenInjector 실행. reason=${reason ?? "n/a"}`
          );
          log(`POST /yorkie/token (reason=${reason ?? "n/a"})`);
          const res = await fetch(`${USER_API}/yorkie/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${getAccessToken()}`,
            },
            body: JSON.stringify({ noteId }),
          });
          log(`yorkie/token → ${res.status}`);
          setTokenApi((s) => ({
            ...s,
            status: res.status,
            ok: res.ok,
            at: nowStr(),
          }));
          if (!res.ok)
            throw new Error(
              `yorkie/token failed: ${res.status} (${reason ?? "n/a"})`
            );

          const payload = await res.json();
          const raw = payload?.data ?? payload;
          const token = raw?.token ?? raw?.data ?? raw?.accessToken;
          const expiresIn = raw?.expiresIn ?? raw?.ttlSeconds;
          const attrs = raw?.documentAttributes ?? raw?.documentAttribute;
          setYorkieToken(token);
          setTokenApi({
            ok: true,
            status: res.status,
            at: nowStr(),
            expiresIn,
            attrKey: attrs?.key,
            attrVerb: attrs?.verb,
          });
          log(
            `Yorkie token OK (ttl=${expiresIn ?? "?"}s, key=${
              attrs?.key ?? "-"
            }, verb=${attrs?.verb ?? "-"})`
          );
          return token as string;
        };

        // JS SDK 문서 권장: 객체 형태 생성자 사용
        const client = new yorkie.Client({
          rpcAddr,
          apiKey: API_KEY,
          authTokenInjector,
        });
        await client.activate();
        clientRef.current = client;
        log("client.activate() 완료");

        const doc = new yorkie.Document<DocType, Presence>(dockey);
        await client.attach(doc);
        docRef.current = doc;
        setAttachState({ attached: true, at: nowStr(), sync: "attached" });
        log(`client.attach(${dockey}) 완료`);

        // 초기 내용 반영
        doc.update((root) => {
          if (!root.content) root.content = new yorkie.Text();
          const text = root.content.toString();
          if (textareaRef.current && textareaRef.current.value !== text) {
            textareaRef.current.value = text;
          }
        });

        // 원격 변경 적용
        doc.subscribe((event: any) => {
          if (event.type === "remote-change") {
            const text = doc.getRoot().content?.toString() ?? "";
            if (textareaRef.current) textareaRef.current.value = text;
          }
        });

        // 상태 이벤트
        doc.subscribe("sync", (e: any) => {
          setStatus(`Sync: ${e.value}`);
          setAttachState((s) => ({
            ...s,
            sync: String(e.value),
            at: nowStr(),
          }));
          log(`sync: ${e.value}`);
        });

        // 인증 에러 이벤트(토큰 만료·권한 부족 등)
        doc.subscribe("auth-error", (e: any) => {
          const msg = `auth-error: method=${e.value.method}, reason=${e.value.reason}`;
          setError(msg);
          setAttachState((s) => ({ ...s, authError: msg, at: nowStr() }));
          log(msg);
        });

        setStatus("편집 준비 완료");
      } catch (e: any) {
        console.error("[DEBUG] Yorkie 연결 예외!", e);
        setError(String(e?.message ?? e));
        setStatus("Yorkie 연결 실패");
        log(`Yorkie 연결 실패: ${String(e)}`);
      }
    })();

    return () => {
      (async () => {
        try {
          if (docRef.current && clientRef.current) {
            await clientRef.current.detach(docRef.current);
            log("client.detach() 완료");
          }
          if (clientRef.current) {
            await clientRef.current.deactivate();
            log("client.deactivate() 완료");
          }
        } catch (e: any) {
          log(`cleanup error: ${String(e)}`);
        }
      })();
    };
  }, [role, dockey, noteId, rpcAddr]);

  // 3) 입력 핸들러
  const onInput = () => {
    if (!docRef.current || role === "READER") return;
    const value = textareaRef.current?.value ?? "";
    docRef.current.update((root) => {
      if (!root.content) root.content = new yorkie.Text();
      root.content!.edit(0, root.content!.length, value);
    });
  };

  const badge = (ok?: boolean) =>
    ok === undefined
      ? "bg-gray-200 text-gray-700"
      : ok
      ? "bg-emerald-100 text-emerald-700"
      : "bg-red-100 text-red-700";

  const fmtSec = (s?: number | null) =>
    s == null ? "-" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-10 px-6">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow p-6 space-y-5 border border-gray-200">
        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-indigo-600">
            📄 Note #{noteId}
          </h1>
          <span className="text-xs text-gray-500">
            dockey: <code>{dockey}</code> | rpc: <code>{rpcAddr || "…"}</code>
          </span>
        </div>

        {/* 상태 뱃지 */}
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full font-medium">
            Role: {role ?? "..."}
          </span>
          <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full">
            {status}
          </span>
          <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full">
            Session Token: {tokenPreview || "없음"}
          </span>
        </div>

        {/* 에러 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 p-3 rounded-md">
            {error}
          </div>
        )}

        {/* API 카드 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Permission */}
          <div className="border rounded-lg p-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">1) Permission</h3>
              <span
                className={`px-2 py-0.5 text-xs rounded ${badge(permApi.ok)}`}
              >
                {permApi.ok === undefined ? "..." : permApi.ok ? "OK" : "FAIL"}
              </span>
            </div>
            <div className="mt-2 text-xs text-gray-600">
              <div>Status: {permApi.status ?? "-"}</div>
              <div>At: {permApi.at ?? "-"}</div>
            </div>
          </div>

          {/* Yorkie Token */}
          <div className="border rounded-lg p-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">2) Yorkie Token</h3>
              <span
                className={`px-2 py-0.5 text-xs rounded ${badge(tokenApi.ok)}`}
              >
                {tokenApi.ok === undefined
                  ? "..."
                  : tokenApi.ok
                  ? "OK"
                  : "FAIL"}
              </span>
            </div>
            <div className="mt-2 text-xs text-gray-600 space-y-1">
              <div>Status: {tokenApi.status ?? "-"}</div>
              <div>At: {tokenApi.at ?? "-"}</div>
              <div>
                Attr: <code>{tokenApi.attrKey ?? "-"}</code> /{" "}
                <code>{tokenApi.attrVerb ?? "-"}</code>
              </div>
              <div>TTL(from API): {tokenApi.expiresIn ?? "-"}s</div>
            </div>
          </div>

          {/* Attach & Sync */}
          <div className="border rounded-lg p-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">3) Attach & Sync</h3>
              <span
                className={`px-2 py-0.5 text-xs rounded ${badge(
                  attachState.attached
                )}`}
              >
                {attachState.attached ? "ATTACHED" : "PENDING"}
              </span>
            </div>
            <div className="mt-2 text-xs text-gray-600 space-y-1">
              <div>Sync: {attachState.sync ?? "-"}</div>
              <div>At: {attachState.at ?? "-"}</div>
              <div
                className={
                  attachState.authError ? "text-red-600" : "text-gray-500"
                }
              >
                {attachState.authError
                  ? attachState.authError
                  : "auth-error 없음"}
              </div>
            </div>
          </div>
        </div>

        {/* Yorkie JWT */}
        <div className="border rounded-lg p-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Yorkie JWT</h3>
            <span className="text-xs text-gray-500">
              남은시간: {fmtSec(tokenTimeLeft)}
            </span>
          </div>
          <div className="mt-2">
            {yorkieToken ? (
              <>
                <div className="text-xs break-all bg-gray-50 border rounded p-2">
                  {short(yorkieToken, 32, 24)}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-gray-700">
                    JWT payload 보기
                  </summary>
                  <pre className="text-xs bg-gray-50 border rounded p-2 overflow-auto">
                    {JSON.stringify(yorkieClaims, null, 2)}
                  </pre>
                </details>
              </>
            ) : (
              <div className="text-xs text-gray-500">
                아직 발급되지 않았습니다.
              </div>
            )}
          </div>
        </div>

        {/* 에디터 */}
        <textarea
          ref={textareaRef}
          onInput={onInput}
          disabled={role === "READER"}
          placeholder={
            role === "READER" ? "읽기 전용 모드입니다." : "내용을 입력하세요..."
          }
          className="w-full h-72 resize-none border border-gray-300 rounded-lg p-4 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
        />

        {/* Dev 도구 */}
        <div className="mt-1 flex gap-2 items-center">
          <input
            id="dev-jwt-input"
            type="text"
            placeholder="여기에 JWT(액세스 토큰) 붙여 넣기 — 세션에 저장됨"
            className="flex-1 border rounded px-3 py-2 text-xs"
          />
          <button
            onClick={setJwt}
            className="px-3 py-2 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-xs"
          >
            세션에 저장
          </button>
          <button
            onClick={clearJwt}
            className="px-3 py-2 rounded bg-gray-600 hover:bg-gray-700 text-white text-xs"
          >
            삭제
          </button>
        </div>

        {/* 디버그 로그 */}
        <div className="mt-3">
          <details className="rounded border bg-gray-50">
            <summary className="cursor-pointer px-3 py-2 text-sm text-gray-700">
              디버그 로그
            </summary>
            <div className="max-h-60 overflow-auto p-3 space-y-1 text-xs font-mono text-gray-800">
              {debug.length === 0 ? (
                <div className="text-gray-400">로그 없음</div>
              ) : (
                debug.map((line, i) => <div key={i}>{line}</div>)
              )}
            </div>
          </details>
        </div>

        <p className="text-xs text-gray-500">
          🔐 이 페이지는 <code>sessionStorage</code>의 <code>accessToken</code>
          만 사용합니다. 탭마다 다른 토큰으로 로그인 테스트가 가능합니다.
        </p>
      </div>
    </div>
  );
}
