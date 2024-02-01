# DualWriter

At work I ran into the problem of having the project divided into a custom library and the main application. When making changes in the library I had to go to the main application to paste the changes to test them, with the danger of leaving something out and not knowing where the error came from.

Tedious, isn't it? So I got tired and I started to make my first extension for VSCode.

In a nutshell, it replicates changes made in one directory to another.

## Extension Settings

Before using it, make sure you set it up! No hot-swapping.

* `dualwriter.enableAutoSave`: Enable/disable the autosave feature.
* `dualwriter.mainDirectory`: The main directory where you will write your changes.
* `dualwriter.secondaryDirectory`: The secondary directory where the extension will write for you.

## How to use

- **Visual command name**: Sync Files
- **Shortcut:** Windows: Ctrl+Alt+F | Mac: CMD+Alt+F
- **Autosave:** Everyone loves this (even if it can be a little bit dangerous...) but you need to enable this at your settings.json

## Known Issues

1. Now there is no error control, only if main and secondary directory are the same.
2. If the target directory is not the one you want, even if it does not have a similar structure, it will create the necessary folders without warning. Choose right.

## Release Notes

### 1.0.0

Initial release of DualWriter for use at work, I'm tired of copy/pasting!

© [2024] Luis Meza