// Shared between the desktop dock (ResizableDock) and the mobile drawer
// (DocWorkspace) so the Changes/Cleo split preference carries over between
// layouts instead of each remembering its own.
export const SPLIT_KEY = "folio:dock:split";
export const DEFAULT_SPLIT = 0.6; // DiffPanel gets the top 60%, Cleo the rest
