/** Preload for the frameless quick-ask spotlight window. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("qa", {
  submit: (text: string) => ipcRenderer.send("quick-ask-submit", text),
  close: () => ipcRenderer.send("quick-ask-close"),
});
