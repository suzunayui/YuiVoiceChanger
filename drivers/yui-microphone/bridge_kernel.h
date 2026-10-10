// SPDX-License-Identifier: MIT
#pragma once
#include <ntddk.h>
void YuiBridgeInitialize();
void YuiBridgeReset();
void YuiBridgeRender(const UCHAR* data, ULONG bytes);
void YuiBridgeCapture(UCHAR* data, ULONG bytes);
