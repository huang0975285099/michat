export async function deleteAccountThenClear(deleteRemote, clearLocal) {
  await deleteRemote()
  await clearLocal()
}
