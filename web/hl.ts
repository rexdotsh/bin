import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";

hljs.registerLanguage("dockerfile", dockerfile);

export default hljs;
