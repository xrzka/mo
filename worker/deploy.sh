export CLOUDFLARE_API_TOKEN="7766c98384d8637015432f69f5c23289a8e56908"
export XDG_CONFIG_HOME="D:/local_translate_tool/wrangler_home"
cd D:\local_translate_tool\mo_site\worker
npx wrangler deploy 2>&1 | Select-Object -Last 8
