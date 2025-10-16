// app/note/[noteId]/page.tsx
"use client";

import { use } from "react"; // ✅ Next.js 15 / React 19: params 언래핑
import { useEffect, useMemo, useRef, useState } from "react";
import * as yorkie from "@yorkie-js/sdk";

// 🔧 env를 문자열로 고정(타입 경고 제거)
const RPC_ADDR = process.env.NEXT_PUBLIC_YORKIE_RPC_ADDR as string;
const API_KEY = process.env.NEXT_PUBLIC_YORKIE_API_KEY as string;
const USER_API = process.env.NEXT_PUBLIC_USER_API as string;

// 초기엔 content가 없을 수 있음 → optional
type DocType = { content?: yorkie.Text };
type Presence = { name: string; color: string };

// 문자열 줄임 표시
const short = (s?: string | null, head = 12, tail = 8) =>
  !s
    ? ""
    : s.length <= head + tail
    ? s
    : `${s.slice(0, head)}…${s.slice(-tail)}`;

// ── ✅ 세션 전용 토큰 유틸 ─────────────────────────────────────────
const getAccessToken = () => sessionStorage.getItem("accessToken") ?? "";
const setAccessToken = (value: string) =>
  sessionStorage.setItem("accessToken", value);
const clearAccessToken = () => sessionStorage.removeItem("accessToken");
const readTokenPreview = () => short(sessionStorage.getItem("accessToken"));

// Base64URL → JSON 디코드 (JWT payload용)
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

export default function NotePage({
  params,
}: {
  params: Promise<{ noteId: string }>;
}) {
  // ✅ params Promise 언래핑
  const { noteId } = use(params);

  const [role, setRole] = useState<"OWNER" | "WRITER" | "READER" | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  // 디버그/표시용 상태
  const [debug, setDebug] = useState<string[]>([]);
  const [tokenPreview, setTokenPreview] = useState<string>("");

  // API 상태 카드용
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

  // Yorkie 토큰 & 클레임/만료정보
  const [yorkieToken, setYorkieToken] = useState<string>("");
  const [yorkieClaims, setYorkieClaims] = useState<any>(null);
  const [tokenTimeLeft, setTokenTimeLeft] = useState<number | null>(null); // seconds

  const dockey = useMemo(() => `note-${noteId}`, [noteId]);

  // 🔧 useRef는 null로 초기화
  const clientRef = useRef<yorkie.Client | null>(null);
  const docRef = useRef<yorkie.Document<DocType, Presence> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const nowStr = () => new Date().toLocaleTimeString();
  const log = (m: string) =>
    setDebug((prev) => [`[${nowStr()}] ${m}`, ...prev]);

  // ───────────────────────────────────────────────────────────────
  // 0) 세션 토큰 미리보기
  useEffect(() => {
    setTokenPreview(readTokenPreview() || "");
  }, []);

  const setJwt = () => {
    const el = document.getElementById(
      "dev-jwt-input"
    ) as HTMLInputElement | null;
    if (el?.value) {
      setAccessToken(el.value);
      setTokenPreview(readTokenPreview() || "");
      alert("세션에 JWT 저장 완료! 새로고침(F5) 하세요.");
    }
  };
  const clearJwt = () => {
    clearAccessToken();
    setTokenPreview("");
    alert("세션에서 JWT 삭제됨.");
  };

  // ───────────────────────────────────────────────────────────────
  // 1) 내 권한 조회
  useEffect(() => {
    (async () => {
      // ⬅️ DEBUG: API 호출 시작점에 로그 추가
      console.log(`[DEBUG] 1. 권한 조회를 시작합니다. noteId: ${noteId}`);
      try {
        setStatus("권한 확인 중...");
        log(`GET /permission/${noteId}/me`);
        const res = await fetch(`${USER_API}/api/v1/permission/${noteId}/me`, {
          headers: { Authorization: `Bearer ${getAccessToken()}` },
        });
        log(`permission/me → ${res.status}`);
        setPermApi({ ok: res.ok, status: res.status, at: nowStr() });

        // ⬅️ DEBUG: 응답 상태 로그 추가
        console.log(
          `[DEBUG] 2. 권한 API 응답 받음. Status: ${res.status}`,
          res
        );

        if (!res.ok) {
          // ⬅️ DEBUG: 실패 시 에러 로그 강화
          console.error(`[DEBUG] 🚨 권한 API 호출 실패! Status: ${res.status}`);
          throw new Error(`permission/me failed: ${res.status}`);
        }

        const body = await res.json();

        // ⬅️ DEBUG: 응답 본문 전체를 로그로 확인
        console.log("[DEBUG] 3. 권한 API 응답 본문(body):", body);

        const userRole = body.data?.role ?? null;

        // ⬅️ DEBUG: 추출된 role 값과 상태 변경 전 로그
        console.log(
          `[DEBUG] 4. 응답에서 추출된 role: ${userRole}. 이제 state를 업데이트합니다.`
        );

        setRole(userRole);
        setStatus("권한 확인 완료");
      } catch (e: any) {
        // ⬅️ DEBUG: try-catch 블록에서 에러 발생 시 로그
        console.error("[DEBUG] 🚨 권한 조회 중 예외 발생!", e);
        setError(String(e?.message ?? e));
        setStatus("권한 조회 실패");
        setPermApi((p) => ({ ...p, ok: false, at: nowStr() }));
        log(`permission/me error: ${String(e)}`);
      }
    })();
  }, [noteId]);

  // Yorkie 토큰 만료 카운트다운
  useEffect(() => {
    if (!yorkieToken) return;
    const claims = decodeJwtPayload(yorkieToken);
    setYorkieClaims(claims);
    let timer: any;
    const tick = () => {
      if (claims?.exp) {
        const left = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
        setTokenTimeLeft(left);
      }
    };
    tick();
    timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [yorkieToken]);

  // ───────────────────────────────────────────────────────────────
  // 2) Yorkie client + document attach
  useEffect(() => {
    // ⬅️ DEBUG: Yorkie 로직의 실행 조건(role) 확인
    console.log(`[DEBUG] 5. Yorkie 로직 실행 여부 확인. 현재 role: "${role}"`);

    if (!role) {
      // ⬅️ DEBUG: role이 없어서 실행이 중단될 때 로그
      if (role === null) {
        console.warn(
          "[DEBUG] ⚠️ role이 null입니다. Yorkie 로직을 건너뜁니다. (권한이 없거나 API 응답 구조 문제일 수 있습니다)"
        );
      }
      return;
    }

    // ⬅️ DEBUG: Yorkie 로직이 실제로 시작될 때 로그
    console.log("[DEBUG] ✅ role 확인 완료. Yorkie 연결을 시작합니다.");

    (async () => {
      try {
        setStatus("Yorkie 연결 중...");
        log("Yorkie Client 생성 시도");

        // ⬇️ SDK 버전에 따라 생성자 시그니처가 다름을 대비
        const ClientCtor: any = (yorkie as any).Client;
        let client: yorkie.Client;

        // 공통 authTokenInjector
        const authTokenInjector = async (reason?: string) => {
          // ⬅️ DEBUG: 가장 중요한 yorkie/token 호출 직전 로그
          console.log(
            `[DEBUG] 🚀 드디어 authTokenInjector 실행! POST /yorkie/token 호출합니다. (reason=${
              reason ?? "n/a"
            })`
          );
          log(`POST /yorkie/token (reason=${reason ?? "n/a"})`);
          const res = await fetch(`${USER_API}/api/v1/yorkie/token`, {
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
          // 응답 다양한 형태 대비
          const raw = payload?.data ?? payload;
          let token: string | undefined;
          let expiresIn: number | undefined;
          let attrKey: string | undefined;
          let attrVerb: string | undefined;

          if (raw && typeof raw === "object") {
            token = raw.token ?? raw?.data ?? raw?.accessToken;
            expiresIn = raw.expiresIn ?? raw.ttlSeconds;
            const attrs = raw.documentAttributes ?? raw.documentAttribute;
            if (attrs) {
              attrKey = attrs.key;
              attrVerb = attrs.verb;
            }
          } else if (typeof raw === "string") {
            token = raw;
          }
          if (!token) throw new Error("no yorkie token in response");

          setYorkieToken(token);
          setTokenApi({
            ok: true,
            status: res.status,
            at: nowStr(),
            expiresIn,
            attrKey,
            attrVerb,
          });
          log(
            `Yorkie token OK (expiresIn=${expiresIn ?? "?"}s, key=${
              attrKey ?? "-"
            }, verb=${attrVerb ?? "-"})`
          );
          return token;
        };

        try {
          // 패턴1: new Client(rpcAddr, opts)
          client = new ClientCtor(RPC_ADDR, {
            apiKey: API_KEY,
            authTokenInjector,
          });
        } catch {
          // 패턴2: new Client({ rpcAddr, ... })
          client = new ClientCtor({
            rpcAddr: RPC_ADDR,
            apiKey: API_KEY,
            authTokenInjector,
          });
        }

        await client.activate();
        clientRef.current = client;
        log("client.activate() 완료");

        const doc = new yorkie.Document<DocType, Presence>(dockey);
        await client.attach(doc); // 옵션 없이(버전 간 타입 충돌 회피)
        docRef.current = doc;
        setAttachState({ attached: true, at: nowStr(), sync: "attached" });
        log(`client.attach(${dockey}) 완료`);

        // 초기 내용 보장
        doc.update((root) => {
          if (!root.content) root.content = new yorkie.Text();
          const text = root.content.toString();
          if (textareaRef.current && textareaRef.current.value !== text) {
            textareaRef.current.value = text;
          }
        });
        log("문서 초기화 완료");

        // 원격 변경 → textarea 반영
        doc.subscribe((event: any) => {
          if (event.type === "remote-change") {
            const text = doc.getRoot().content?.toString() ?? "";
            if (textareaRef.current) textareaRef.current.value = text;
          }
        });

        // 상태/에러 로그
        doc.subscribe("sync", (e: any) => {
          setStatus(`Sync: ${e.value}`);
          setAttachState((s) => ({
            ...s,
            sync: String(e.value),
            at: nowStr(),
          }));
          log(`sync: ${e.value}`);
        });
        doc.subscribe("auth-error", (e: any) => {
          const msg = `auth-error: method=${e.value.method}, reason=${e.value.reason}`;
          setError(msg);
          setAttachState((s) => ({ ...s, authError: msg, at: nowStr() }));
          log(msg);
        });

        setStatus("편집 준비 완료");
      } catch (e: any) {
        // ⬅️ DEBUG: Yorkie 연결 중 예외 발생 시 로그
        console.error("[DEBUG] 🚨 Yorkie 연결 중 예외 발생!", e);
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
  }, [role, dockey, noteId]);

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

  // UI helpers
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
          <span className="text-sm text-gray-500">
            dockey: <code>{dockey}</code>
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

        {/* 에러 표시 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 p-3 rounded-md">
            {error}
          </div>
        )}

        {/* ▶ API 상태 카드들 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* 1) Permission */}
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

          {/* 2) Yorkie Token */}
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

          {/* 3) Attach & Sync */}
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

        {/* ▶ Yorkie JWT 표시/디코드 */}
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

        {/* Dev 도구: 세션 토큰 입력/삭제 */}
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
