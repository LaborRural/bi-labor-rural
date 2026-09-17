@echo off
title BI Labor Rural - Teste Local Dashboard
cd /d "%~dp0"

echo ====================================================
echo   BI LABOR RURAL - DASHBOARD COM DADOS DO SUPABASE
echo ====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js nao encontrado. Instale o Node.js para iniciar o dashboard.
    pause
    exit /b 1
)

if not exist ".env.local" (
    echo Arquivo .env.local nao encontrado. Configure as credenciais do Supabase.
    pause
    exit /b 1
)

if not exist "node_modules\@supabase\supabase-js" (
    echo Instalando dependencias do dashboard...
    call npm install
    if errorlevel 1 (
        echo Nao foi possivel instalar as dependencias.
        pause
        exit /b 1
    )
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5050 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

start "BI Labor Rural - Servidor" cmd /k "npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5050"

echo Dashboard iniciado com as APIs e os dados do Supabase.
echo A janela do servidor continuara aberta em segundo plano.
pause
