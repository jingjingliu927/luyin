const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  resizeFloat(width, height) {
    ipcRenderer.send("resize-float", width, height);
  },
  onAlarmTriggered(callback) {
    ipcRenderer.on("alarm-triggered", (_event, data) => callback(data));
  },
});
