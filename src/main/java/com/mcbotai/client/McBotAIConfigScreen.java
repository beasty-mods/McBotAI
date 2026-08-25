package com.mcbotai.client;

import com.mojang.blaze3d.matrix.MatrixStack;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.AbstractGui;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.client.gui.widget.button.Button;
import net.minecraft.util.text.StringTextComponent;

import java.io.File;
import java.io.IOException;

public class McBotAIConfigScreen extends Screen {

    private final Screen parent;

    private TextFieldWidget hostField;
    private TextFieldWidget portField;
    private TextFieldWidget usernameField;
    private TextFieldWidget mastersField;

    private String statusMessage = "";
    private boolean statusIsError = false;

    public McBotAIConfigScreen(Screen parent) {
        super(new StringTextComponent("McBotAI Configuration"));
        this.parent = parent;
    }

    @Override
    protected void init() {

        int centerX = this.width / 2;

        int fieldWidth = 260;
        int fieldHeight = 20;

        int leftX = centerX - fieldWidth / 2;

        int y = 50;

        // IMPORTANT:
        // 34px between rows so the labels/placeholders don't overlap.
        int rowGap = 34;

        this.hostField = new TextFieldWidget(
                this.font,
                leftX,
                y,
                fieldWidth,
                fieldHeight,
                new StringTextComponent("Server IP / Host")
        );
        this.hostField.setMaxLength(128);
        this.hostField.setValue(McBotAIConfig.host);
        this.addButton(this.hostField);

        y += rowGap;

        this.portField = new TextFieldWidget(
                this.font,
                leftX,
                y,
                fieldWidth,
                fieldHeight,
                new StringTextComponent("Port")
        );
        this.portField.setMaxLength(6);
        this.portField.setValue(McBotAIConfig.port);
        this.addButton(this.portField);

        y += rowGap;

        this.usernameField = new TextFieldWidget(
                this.font,
                leftX,
                y,
                fieldWidth,
                fieldHeight,
                new StringTextComponent("Bot Username")
        );
        this.usernameField.setMaxLength(32);
        this.usernameField.setValue(McBotAIConfig.username);
        this.addButton(this.usernameField);

        y += rowGap;

        this.mastersField = new TextFieldWidget(
                this.font,
                leftX,
                y,
                fieldWidth,
                fieldHeight,
                new StringTextComponent("Master Username(s)")
        );
        this.mastersField.setMaxLength(128);
        this.mastersField.setValue(McBotAIConfig.masters);
        this.addButton(this.mastersField);

        y += rowGap;

        this.addButton(new Button(
                leftX,
                y,
                fieldWidth,
                fieldHeight,
                new StringTextComponent("Setup Bot"),
                button -> this.setupBot()
        ));

        y += rowGap;

        this.addButton(new Button(
                leftX,
                y,
                fieldWidth,
                fieldHeight,
                new StringTextComponent("Open Bot Folder"),
                button -> this.openBotFolder()
        ));

        y += 42;

        int buttonWidth = (fieldWidth - 10) / 2;

        this.addButton(new Button(
                leftX,
                y,
                buttonWidth,
                20,
                new StringTextComponent("Save"),
                button -> saveAndClose()
        ));

        this.addButton(new Button(
                leftX + buttonWidth + 10,
                y,
                buttonWidth,
                20,
                new StringTextComponent("Cancel"),
                button -> this.onClose()
        ));
    }

    @Override
    public void tick() {

        this.hostField.tick();
        this.portField.tick();
        this.usernameField.tick();
        this.mastersField.tick();
    }

    @Override
    public void render(
            MatrixStack matrixStack,
            int mouseX,
            int mouseY,
            float partialTicks
    ) {

        this.renderDirtBackground(0);

        AbstractGui.drawCenteredString(
                matrixStack,
                this.font,
                this.title,
                this.width / 2,
                20,
                0xFFFFFF
        );

        drawFieldLabel(matrixStack, this.hostField, "Server IP / Host");
        drawFieldLabel(matrixStack, this.portField, "Port");
        drawFieldLabel(matrixStack, this.usernameField, "Bot Username");
        drawFieldLabel(matrixStack, this.mastersField, "Master Username(s) — comma separated");

        super.render(matrixStack, mouseX, mouseY, partialTicks);

        if (!this.statusMessage.isEmpty()) {
            int color = this.statusIsError ? 0xFF5555 : 0x55FF55;
            AbstractGui.drawCenteredString(
                    matrixStack,
                    this.font,
                    new StringTextComponent(this.statusMessage),
                    this.width / 2,
                    this.mastersField.y + 146,
                    color
            );
        }
    }

    private void drawFieldLabel(MatrixStack matrixStack, TextFieldWidget field, String label) {
        AbstractGui.drawString(matrixStack, this.font, label, field.x, field.y - 10, 0xA0A0A0);
    }

    private void saveAndClose() {

        McBotAIConfig.host = this.hostField.getValue().trim();
        McBotAIConfig.port = this.portField.getValue().trim();
        McBotAIConfig.username = this.usernameField.getValue().trim();
        McBotAIConfig.masters = this.mastersField.getValue().trim();

        McBotAIConfig.save();

        this.onClose();
    }

    @Override
    public void onClose() {
        Minecraft.getInstance().setScreen(this.parent);
    }

    @Override
    public boolean isPauseScreen() {
        return true;
    }

    // ---- Bot setup (copy bundled bot -> config, then npm install) ----

    private void setupBot() {

        this.setStatus("Setting up...", false);

        // Copying and running npm install are both slow, blocking
        // filesystem/process operations - neither belongs on the render
        // thread.
        new Thread(() -> {
            try {
                Minecraft.getInstance().execute(() -> this.setStatus("Copying bot files...", false));
                McBotAISetup.copyBotToConfig();

                File botDir = McBotAISetup.getBotDir();
                File nodeExe = McBotAISetup.getNodeExecutable();
                File npmCliJs = McBotAISetup.getNpmCliJs();

                if (!nodeExe.isFile()) {
                    throw new IOException("node.exe not found at " + nodeExe.getAbsolutePath());
                }
                if (!npmCliJs.isFile()) {
                    throw new IOException("npm-cli.js not found at " + npmCliJs.getAbsolutePath());
                }

                Minecraft.getInstance().execute(() ->
                        this.setStatus("Running npm install (this can take a minute)...", false));

                ProcessBuilder pb = new ProcessBuilder(
                        nodeExe.getAbsolutePath(), npmCliJs.getAbsolutePath(), "install"
                );
                pb.directory(botDir);
                pb.redirectErrorStream(true);
                pb.redirectOutput(new File(botDir, "npm-install.log"));

                Process process = pb.start();
                int exitCode = process.waitFor();

                if (exitCode == 0) {
                    Minecraft.getInstance().execute(() -> this.setStatus(
                            "Setup complete! Use \"Launch Bot\" in the pause menu's McBotAI button to start it.",
                            false
                    ));
                } else {
                    Minecraft.getInstance().execute(() -> this.setStatus(
                            "npm install failed (exit " + exitCode + ") - see npm-install.log in the bot folder.",
                            true
                    ));
                }
            } catch (Exception e) {
                String message = e.getMessage() != null ? e.getMessage() : e.toString();
                Minecraft.getInstance().execute(() ->
                        this.setStatus("Setup failed: " + message, true));
            }
        }, "McBotAI-Setup").start();
    }

    private void setStatus(String message, boolean isError) {
        this.statusMessage = message;
        this.statusIsError = isError;
    }

    // ---- Open bot folder in the system file explorer ----

    private void openBotFolder() {
        File botDir = McBotAISetup.getBotDir();
        botDir.mkdirs();

        // Uses the OS's own file-explorer command via ProcessBuilder -
        // the same plain, dependency-free technique already used to
        // launch node.exe, rather than java.awt.Desktop (which touches
        // AWT and hit a real headless-mode crash earlier in this
        // project's history for a similar file-picker feature).
        String os = System.getProperty("os.name", "").toLowerCase();
        ProcessBuilder pb;
        if (os.contains("win")) {
            pb = new ProcessBuilder("explorer.exe", botDir.getAbsolutePath());
        } else if (os.contains("mac")) {
            pb = new ProcessBuilder("open", botDir.getAbsolutePath());
        } else {
            pb = new ProcessBuilder("xdg-open", botDir.getAbsolutePath());
        }

        try {
            pb.start();
        } catch (IOException e) {
            String message = e.getMessage() != null ? e.getMessage() : e.toString();
            this.setStatus("Couldn't open the folder: " + message, true);
        }
    }
}
