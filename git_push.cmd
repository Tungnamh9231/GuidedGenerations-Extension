@echo off
chcp 65001 >nul 2>&1
title Git Auto Commit - GuidedGenerations-Extension
color 0A

echo =========================================================
echo   GuidedGenerations-Extension - Git Commit and Push
echo =========================================================
echo.

cd /d "%~dp0"

REM Check if this is a git repository
if not exist ".git" (
    color 0C
    echo [ERROR] Day khong phai la mot git repository!
    echo.
    pause
    exit /b 1
)

REM Show current branch
echo --- Branch hien tai ---
for /f "tokens=*" %%b in ('git branch --show-current') do (
    echo    Branch: %%b
)
echo.

REM Show git status
echo --- Trang thai thay doi ---
git status --short
echo.

REM Check if there are any changes
set "HAS_CHANGE=0"
for /f %%i in ('git status --porcelain') do set "HAS_CHANGE=1"

if "%HAS_CHANGE%"=="0" (
    echo [INFO] Khong co thay doi nao de commit.
    echo.
    pause
    exit /b 0
)

REM Show diff stats
echo --- Chi tiet thay doi ---
git diff --stat
echo.

REM Ask to stage all changes
echo =========================================================
echo   Ban muon add tat ca thay doi? [Y/N]
echo =========================================================
set /p "ADD_ALL=  Lua chon [Y/N]: "

if /i "%ADD_ALL%"=="Y" (
    git add -A
    echo.
    echo [OK] Da add tat ca thay doi.
) else (
    echo.
    echo Dang mo git interactive add...
    git add -i
)

echo.

REM Show staged files
echo --- Cac file se duoc commit ---
git diff --cached --stat
echo.

REM Ask for commit message
echo =========================================================
echo   Nhap noi dung commit message:
echo =========================================================
set /p "COMMIT_MSG=  Commit message: "

if "%COMMIT_MSG%"=="" (
    color 0C
    echo.
    echo [ERROR] Commit message khong duoc de trong!
    echo.
    git reset HEAD >nul 2>&1
    pause
    exit /b 1
)

echo.

REM Confirm before commit
echo =========================================================
echo   Xac nhan commit voi message:
echo   "%COMMIT_MSG%"
echo.
echo   Tiep tuc? [Y/N]
echo =========================================================
set /p "CONFIRM=  Xac nhan [Y/N]: "

if /i not "%CONFIRM%"=="Y" (
    echo.
    echo [CANCEL] Da huy commit.
    git reset HEAD >nul 2>&1
    echo.
    pause
    exit /b 0
)

REM Commit
echo.
echo Dang commit...
git commit -m "%COMMIT_MSG%"

if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo [ERROR] Commit that bai!
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] Commit thanh cong!
echo.

REM Ask to push
echo =========================================================
echo   Ban muon push len GitHub? [Y/N]
echo =========================================================
set /p "PUSH_CONFIRM=  Push? [Y/N]: "

if /i not "%PUSH_CONFIRM%"=="Y" (
    echo.
    echo [INFO] Da commit nhung chua push.
    echo        Ban co the push sau bang lenh: git push
    echo.
    pause
    exit /b 0
)

REM Push to remote
echo.
echo Dang push len GitHub...
git push

if %ERRORLEVEL% neq 0 (
    color 0E
    echo.
    echo [WARNING] Push that bai! Thu push voi set upstream...
    for /f "tokens=*" %%b in ('git branch --show-current') do (
        git push --set-upstream origin %%b
    )

    if %ERRORLEVEL% neq 0 (
        color 0C
        echo.
        echo [ERROR] Push that bai! Kiem tra lai ket noi va quyen truy cap.
        echo.
        pause
        exit /b 1
    )
)

echo.
color 0A
echo =========================================================
echo   HOAN TAT - Commit va Push thanh cong!
echo =========================================================
echo.
echo   Commit: %COMMIT_MSG%
for /f "tokens=*" %%b in ('git branch --show-current') do echo   Branch: %%b
echo.
pause
