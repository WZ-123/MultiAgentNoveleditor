# 定义身份配置文件路径 (在当前项目的上级目录，即 G:\MANA\.gitconfig-mana)
$WorkspaceRoot = Resolve-Path ".."
$IdentityFile = Join-Path $WorkspaceRoot ".gitconfig-mana"

# 定义身份信息
$IdentityContent = @"
[user]
    name = WZ-123
    email = 1409714278@qq.com
"@

# 1. 创建身份配置文件
Write-Host "正在创建身份配置文件: $IdentityFile"
Set-Content -Path $IdentityFile -Value $IdentityContent

# 2. 配置全局 Git 使用 conditional include
# 注意: git路径需要使用正斜杠
$GitDirPattern = "gitdir/i:$(($WorkspaceRoot.Path -replace '\\', '/'))/"
$IdentityFileGitPath = $IdentityFile -replace '\\', '/'

Write-Host "正在配置全局 Git includeIf..."
git config --global includeIf."$GitDirPattern".path "$IdentityFileGitPath"

Write-Host "✅ 配置完成！"
Write-Host "以后在 $WorkspaceRoot 下的任何 Git 仓库中，都会自动使用以下身份："
git config -f $IdentityFile user.name
git config -f $IdentityFile user.email
