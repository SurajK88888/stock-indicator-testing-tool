# 🛠️ Professional Git & GitHub Guide

This guide contains the exact procedures for managing repositories, fixing mistakes, and maintaining a clean workflow.

---

## 1. 🔗 Connecting to GitHub (New Project)
Use these steps when you have code locally and want to push it to a *new* GitHub repo.

```powershell
# 1. Initialize git locally
git init

# 2. Add all files (respecting .gitignore)
git add .

# 3. Create initial commit
git commit -m "Initial commit"

# 4. Create a main branch
git branch -M main

# 5. Link to your GitHub Repo
git remote add origin https://github.com/USERNAME/REPO_NAME.git

# 6. Push to GitHub
git push -u origin main
```

---

## 2. 🔌 Disconnecting from GitHub
If you want to stop syncing with a specific GitHub repo but **keep** your local history.

```powershell
# View current remote
git remote -v

# Remove the link to GitHub
git remote remove origin
```

---

## 3. ♻️ The "Fresh Start" (Total Reset)
Use this if your Git history is messy or you have "Submodule/Embedded" errors and want to start zero.

```powershell
# 1. Delete the hidden .git folders (BE CAREFUL)
Remove-Item -Path ".git" -Recurse -Force

# 2. If sub-folders (like frontend) have their own git:
Remove-Item -Path "frontend\.git" -Recurse -Force

# 3. Start over
git init
git add .
git commit -m "Fresh Start"
```

---

## 4. 🧹 Managing Tracking (Files & Folders)

### How to stop tracking a file (but keep it on your PC)
Use this if you accidentally uploaded something like `database.db` or `node_modules` and want to remove it from GitHub.

```powershell
# 1. Add the file/folder to .gitignore first
# 2. Remove from Git index (untrack)
git rm -r --cached folder_name/   # For folders
git rm --cached file_name.txt     # For files

# 3. Commit the change
git commit -m "Stopped tracking unwanted files"
```

---

## 5. ⏪ Managing Commits (Undo/Delete)

### Undo the last commit (Keep your code changes)
```powershell
git reset --soft HEAD~1
```

### Delete the last commit (Discard all code changes)
```powershell
git reset --hard HEAD~1
```

### Change the last commit message
```powershell
git commit --amend -m "New better message"
```

---

## 6. 🛠️ Fixing Common Issues

### "Embedded Repository" Warning
This happens if a subfolder has its own `.git`.
1. Delete `subfolder/.git` folder.
2. `git rm --cached subfolder`
3. `git add .`
4. `git commit -m "Fixed embedded repo"`

### Branch is behind/diverged
If GitHub has changes you don't have:
```powershell
git pull origin main --rebase
```

---

## 💡 Best Practices
1. **Always check status:** Run `git status` before every `git add`.
2. **Atomic Commits:** Commit one feature at a time (e.g., "Added login UI" instead of "Big update").
3. **Branching:** Use branches for new features: `git checkout -b feature-name`.
