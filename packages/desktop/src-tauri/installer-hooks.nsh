; Recordings live in the user's Videos folder, outside anything the uninstaller removes.
!macro NSIS_HOOK_PREUNINSTALL
  ${IfNot} ${Silent}
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    MessageBox MB_OK|MB_ICONINFORMATION "Your recordings are kept. They stay in Videos\Butterfly Record, or in the folder you chose in Settings."
  ${EndIf}
!macroend

; Deleting the app data also removes the API key from Credential Manager
; (a generic credential, type 1; the target name must match keystore.rs).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    System::Call 'advapi32::CredDeleteW(w "Butterfly Record/sarvam", i 1, i 0)'
  ${EndIf}
!macroend
