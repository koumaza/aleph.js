import { base64, brotli } from "../../deps.ts";
export default () => brotli.decompress(base64.decode(dataRaw))