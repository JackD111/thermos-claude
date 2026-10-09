param([Parameter(Mandatory)][string]$Dir)
# Scratch repo for the live thermos check. main has a parameterized query;
# branch `feature` plants a SQL injection and a new 1,100+ line spaghetti file.
New-Item -ItemType Directory -Force (Join-Path $Dir "app") | Out-Null
Set-Location $Dir
git init -q -b main
git config user.email "fixture@example.com"
git config user.name "fixture"
git config core.autocrlf false
$nl = "`n"
[IO.File]::WriteAllText("$Dir\app\db.py", (@(
	'import sqlite3', '', '',
	'def connect(path="app.db"):', '    return sqlite3.connect(path)', '', '',
	'def get_user(conn, username):',
	'    cur = conn.execute("SELECT id, username, email FROM users WHERE username = ?", (username,))',
	'    return cur.fetchone()') -join $nl) + $nl)
[IO.File]::WriteAllText("$Dir\app\users.py", (@(
	'from app.db import connect, get_user', '', '',
	'def lookup(username):', '    conn = connect()', '    try:', '        return get_user(conn, username)', '    finally:', '        conn.close()') -join $nl) + $nl)
git add -A
git commit -q -m "initial"
git checkout -q -b feature
$db = [IO.File]::ReadAllText("$Dir\app\db.py").Replace(
	'cur = conn.execute("SELECT id, username, email FROM users WHERE username = ?", (username,))',
	'cur = conn.execute(f"SELECT id, username, email FROM users WHERE username = ''{username}''")')
[IO.File]::WriteAllText("$Dir\app\db.py", $db)
$body = @('# Report builder', '', '', 'def build_report(rows, mode, region, flags):', '    out = []')
for ($i = 0; $i -lt 220; $i++) {
	$body += "    if mode == 'm$i' and region == 'r$($i % 7)':"
	$body += "        if flags.get('f$i'):"
	$body += "            out.append(('m$i', len(rows) * $i))"
	$body += "        else:"
	$body += "            out.append(('m$i', 0))"
}
$body += '    return out'
[IO.File]::WriteAllText("$Dir\app\report.py", ($body -join $nl) + $nl)
git add -A
git commit -q -m "feature: faster user lookup and report builder"
git log --oneline
"report.py lines: " + (Get-Content "$Dir\app\report.py").Count
