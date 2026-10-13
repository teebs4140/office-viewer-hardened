import { MoonOutlined, SunOutlined, ZoomInOutlined, ZoomOutOutlined } from "@ant-design/icons";
import { Alert, Spin } from "antd";
import { setGoogleFontsEnabled } from "@eigenpal/docx-editor-core";
import { DocxEditor, type DocxEditorRef } from "@eigenpal/docx-editor-react";
import "@eigenpal/docx-editor-react/styles.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { handler, vscodeApi } from "../../util/vscode";
import { loadOfficeBuffer } from "../../util/loadOfficeContent";
import "./Word.css";

// The editor fetches any font a document names from fonts.googleapis.com by default.
// Turn that off before anything renders: a viewer must not make remote requests
// (the CSP blocks them too). Missing fonts fall back to locally installed ones.
setGoogleFontsEnabled(false);

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;

function clampZoom(zoom: number): number {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
}

type WordColorMode = "light" | "adaptive";

const WORD_COLOR_MODE_KEY = "office-word-color-mode";

function loadWordColorMode(): WordColorMode {
    const state = vscodeApi?.getState?.() as { wordColorMode?: WordColorMode } | undefined;
    if (state?.wordColorMode === "light" || state?.wordColorMode === "adaptive") {
        return state.wordColorMode;
    }
    try {
        const saved = localStorage.getItem(WORD_COLOR_MODE_KEY);
        if (saved === "light" || saved === "adaptive") {
            return saved;
        }
    } catch { }
    return "light";
}

function saveWordColorMode(mode: WordColorMode) {
    try {
        localStorage.setItem(WORD_COLOR_MODE_KEY, mode);
    } catch { }
    if (vscodeApi?.setState) {
        const prev = (vscodeApi.getState?.() ?? {}) as Record<string, unknown>;
        vscodeApi.setState({ ...prev, wordColorMode: mode });
    }
}

interface WordOpenPayload {
    path?: string;
    buffer?: number[];
    error?: string;
    readOnly?: boolean;
    fileName?: string;
    documentCacheId?: string;
    nonce?: number;
}

export default function Word() {
    const editorRef = useRef<DocxEditorRef>(null);
    const [colorMode, setColorMode] = useState<WordColorMode>(loadWordColorMode);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [zoom, setZoom] = useState(1);
    const [documentBuffer, setDocumentBuffer] = useState<ArrayBuffer | undefined>(undefined);
    const [documentKey, setDocumentKey] = useState("");
    const [fileName, setFileName] = useState("");
    const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
    const skipCommentsAutoOpenRef = useRef(true);

    const adaptiveColorMode = colorMode === "adaptive";

    const toggleColorMode = () => {
        setColorMode((prev) => {
            const next: WordColorMode = prev === "adaptive" ? "light" : "adaptive";
            saveWordColorMode(next);
            return next;
        });
    };

    // Read-only mode hides the editor toolbar and its zoom control, so zoom lives here.
    const applyZoom = useCallback((next: number) => {
        const value = clampZoom(next);
        editorRef.current?.setZoom(value);
        setZoom(value);
    }, []);

    const zoomBy = useCallback((delta: number) => {
        applyZoom((editorRef.current?.getZoom() ?? zoom) + delta);
    }, [applyZoom, zoom]);

    const loadDocument = useCallback(async (payload: WordOpenPayload) => {
        setLoading(true);
        setError(null);
        setDocumentBuffer(undefined);

        try {
            setZoom(1);
            setFileName(payload.fileName ?? "");
            setDocumentKey(`${payload.documentCacheId ?? ""}-${payload.nonce ?? Date.now()}`);
            skipCommentsAutoOpenRef.current = true;
            setCommentsSidebarOpen(false);
            const buffer = await loadOfficeBuffer(payload);
            setDocumentBuffer(buffer);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load document");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        handler
            .on("open", (payload: WordOpenPayload) => {
                void loadDocument(payload);
            })
            .emit("init");
    }, [loadDocument]);

    useEffect(() => {
        const onWheel = (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey) || !editorRef.current) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
        };
        window.addEventListener("wheel", onWheel, { passive: false });
        return () => window.removeEventListener("wheel", onWheel);
    }, [zoomBy]);

    return (
        <div className={`word-viewer${adaptiveColorMode ? " word-viewer--vscode-theme" : ""}`}>
            <button
                type="button"
                className="dark-mode-toggle"
                title={adaptiveColorMode ? "切换亮色" : "切换暗色（跟随 VS Code 主题）"}
                aria-label={adaptiveColorMode ? "Switch to light mode" : "Switch to adaptive dark mode"}
                onClick={toggleColorMode}
            >
                {adaptiveColorMode ? <SunOutlined /> : <MoonOutlined />}
            </button>
            <Spin spinning={loading} fullscreen />
            {error && <Alert type="error" message={error} showIcon style={{ margin: 16 }} />}
            {documentBuffer && !loading && !error && (
                <div className="word-zoom-control" role="group" aria-label="Zoom">
                    <button type="button" title="Zoom out (Ctrl+wheel)" aria-label="Zoom out"
                        disabled={zoom <= ZOOM_MIN} onClick={() => zoomBy(-ZOOM_STEP)}>
                        <ZoomOutOutlined />
                    </button>
                    <button type="button" className="word-zoom-value" title="Reset zoom" aria-label="Reset zoom"
                        onClick={() => applyZoom(1)}>
                        {Math.round(zoom * 100)}%
                    </button>
                    <button type="button" title="Zoom in (Ctrl+wheel)" aria-label="Zoom in"
                        disabled={zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>
                        <ZoomInOutlined />
                    </button>
                </div>
            )}
            {documentBuffer && !loading && !error && (
                <>
                    <DocxEditor
                        key={documentKey}
                        ref={editorRef}
                        className="word-editor"
                        documentBuffer={documentBuffer}
                        documentName={fileName}
                        documentNameEditable={false}
                        // Read-only viewer: no toolbar, no editing; Ctrl+F find still works.
                        readOnly
                        mode="viewing"
                        commentsSidebarOpen={commentsSidebarOpen}
                        onCommentsSidebarOpenChange={(open) => {
                            if (open && skipCommentsAutoOpenRef.current) {
                                skipCommentsAutoOpenRef.current = false;
                                return;
                            }
                            setCommentsSidebarOpen(open);
                        }}
                        colorMode="light"
                        showFileOpen={false}
                        showHelpMenu={false}
                    />
                </>
            )}
        </div>
    );
}
