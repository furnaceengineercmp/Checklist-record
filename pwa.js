(function(){
  "use strict";
  const SW_URL = "/Checklist-record/sw.js";
  const SW_SCOPE = "/Checklist-record/";

  async function register(){
    if(!("serviceWorker" in navigator)) return null;
    try{
      const reg = await navigator.serviceWorker.register(SW_URL,{scope:SW_SCOPE});
      return reg;
    }catch(e){
      console.warn("PWA Service Worker gagal didaftarkan", e);
      return null;
    }
  }

  async function enableNotifications(){
    if(!("Notification" in window)) return "unsupported";
    if(Notification.permission === "default") return await Notification.requestPermission();
    return Notification.permission;
  }

  async function testNotification(){
    const permission = await enableNotifications();
    if(permission !== "granted") return false;
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if(reg && reg.showNotification){
      await reg.showNotification("Checklist Furnace Area",{
        body:"Notifikasi PWA berhasil. Service Worker aktif.",
        icon:"/Checklist-record/icons/icon-192.png",
        badge:"/Checklist-record/icons/icon-192.png"
      });
    }else{
      new Notification("Checklist Furnace Area",{body:"Notifikasi PWA berhasil."});
    }
    return true;
  }

  window.ChecklistPWA = {register, enableNotifications, testNotification};
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", register);
  else register();
})();
