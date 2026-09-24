@echo off
echo.
echo ===================================
echo   MedHub - Choose push target
echo ===================================
echo   1. Account A  (felixappbuilder-ship-it)
echo   2. Account B  (medhurb2-creator)
echo   3. Cancel
echo ===================================
echo.
set /p choice="Enter choice [1/2/3]: "

if "%choice%"=="1" goto push_a
if "%choice%"=="2" goto push_b
if "%choice%"=="3" goto cancel
echo Invalid choice.
goto end

:push_a
echo.
echo Pushing to Account A...
git push origin-a main
goto end

:push_b
echo.
echo Pushing to Account B...
git push origin-b main
goto end

:cancel
echo Cancelled.

:end
echo.
pause