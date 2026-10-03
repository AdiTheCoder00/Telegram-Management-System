"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, FolderInput, Loader2, Pause, Play, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/dialog";
import { api, errorMessage, ApiError } from "@/lib/client-api";

const NO_GROUP = "__none";
const NEW_GROUP = "__new";

type Result = { results: { id: string; name: string; ok: boolean; error?: string }[] };

/** Bulk actions for selected alerts (pause / resume / group / export / delete). */
export function BulkBar({ selected, groups, onDone }: { selected: string[]; groups: { id: string; name: string }[]; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(action: "pause" | "resume" | "delete" | "group", groupId?: string | null) {
    setBusy(action);
    try {
      const r = await api<Result>("/api/alerts/bulk", { method: "POST", body: { ids: selected, action, groupId } });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(`${failed.length} of ${r.results.length} failed: ${failed[0].name} — ${failed[0].error}`);
      else toast.success(`${r.results.length} alert${r.results.length === 1 ? "" : "s"} updated`);
      onDone();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function moveTo(value: string) {
    if (value === NEW_GROUP) {
      const name = window.prompt("New group name")?.trim();
      if (!name) return;
      try {
        const g = await api<{ group: { id: string } }>("/api/groups", { method: "POST", body: { name } });
        await run("group", g.group.id);
      } catch (err) {
        toast.error(errorMessage(err));
      }
      return;
    }
    await run("group", value === NO_GROUP ? null : value);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
      <span className="font-medium">{selected.length} selected</span>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run("pause")}>
        {busy === "pause" ? <Loader2 className="animate-spin" /> : <Pause />} Pause
      </Button>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run("resume")}>
        {busy === "resume" ? <Loader2 className="animate-spin" /> : <Play />} Resume
      </Button>
      <Select value="" onValueChange={moveTo}>
        <SelectTrigger className="h-8 w-40" aria-label="Move to group">
          <FolderInput className="size-4" />
          <SelectValue placeholder="Move to group" />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
            </SelectItem>
          ))}
          <SelectItem value={NO_GROUP}>No group</SelectItem>
          <SelectItem value={NEW_GROUP}>New group…</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" asChild>
        <a href={`/api/alerts/export?ids=${selected.join(",")}`} download>
          <Download /> Export
        </a>
      </Button>
      <Button size="sm" variant="outline" className="text-destructive" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
        <Trash2 /> Delete
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone} aria-label="Clear selection">
        <X />
      </Button>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${selected.length} alert${selected.length === 1 ? "" : "s"}?`}
        description="Their history is kept. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => run("delete")}
      />
    </div>
  );
}

/** Export-all and import buttons for the alerts toolbar. */
export function ImportExport() {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function onFile(f: File) {
    setImporting(true);
    try {
      if (f.size > 2_000_000) throw new Error("That file is too large (max 2 MB).");
      const json = JSON.parse(await f.text());
      const r = await api<{ imported: number }>("/api/alerts/import", { method: "POST", body: json });
      toast.success(`Imported ${r.imported} alert${r.imported === 1 ? "" : "s"} (paused — review, then resume).`);
      router.refresh();
    } catch (err) {
      const issues = err instanceof ApiError ? ((err.details?.issues as string[] | undefined) ?? []) : [];
      toast.error(`${errorMessage(err)}${issues[0] ? ` ${issues[0]}` : ""}`);
    } finally {
      setImporting(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" asChild>
        <a href="/api/alerts/export" download>
          <Download /> Export all
        </a>
      </Button>
      <Button variant="outline" size="sm" onClick={() => file.current?.click()} disabled={importing}>
        {importing ? <Loader2 className="animate-spin" /> : <Upload />} Import
      </Button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    </div>
  );
}
