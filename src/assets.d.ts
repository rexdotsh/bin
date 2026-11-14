declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*/assets.json" {
  const assets: Record<string, string>;
  export default assets;
}
