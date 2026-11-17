/**
 * Inline script for <head>, run before any of Next's own scripts. Browser extensions (wallets above all) inject scripts
 * such as chrome-extension://<id>/inpage.js into every page, and their uncaught errors and rejections surface as this
 * page's errors: the Next dev overlay shows them as a Runtime Error ("func sseError not found" came from one), and they
 * pollute the console in production. The guard listens in the capture phase on window and stops an error or rejection
 * only when the frame that threw it lives in an extension: the event's filename for errors, the top stack frame for
 * both. Anything thrown from our own origin passes through untouched, even if an extension frame sits lower in its
 * stack. Kept as a string so the layout can inline it.
 */
export const EXTENSION_GUARD = `(function(){
var ext=/^(chrome|moz|safari-web|ms-browser)-extension:\\/\\//;
function top(stack){
  if(!stack)return "";
  var lines=String(stack).split("\\n");
  if(!/^\\s*at |^[^\\s]*@[a-z-]+:\\/\\//.test(lines[0]))lines.shift();
  for(var i=0;i<lines.length;i++){var m=lines[i].match(/[a-z-]+:\\/\\/[^\\s)]+/);if(m)return m[0];}
  return "";
}
function fromExtension(e){
  try{
    if(e.type==="error"){if(e.filename)return ext.test(e.filename);return ext.test(top(e.error&&e.error.stack));}
    return ext.test(top(e.reason&&e.reason.stack));
  }catch(_){return false;}
}
function stop(e){if(fromExtension(e)){e.stopImmediatePropagation();e.preventDefault();}}
window.addEventListener("error",stop,true);
window.addEventListener("unhandledrejection",stop,true);
})();`;
