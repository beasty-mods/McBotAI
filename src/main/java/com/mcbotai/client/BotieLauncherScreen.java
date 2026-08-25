package com.mcbotai.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.matrix.MatrixStack;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.AbstractGui;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.client.gui.widget.button.Button;
import net.minecraft.util.text.StringTextComponent;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Opened from the Pause menu's McBotAI button (see ClientEvents.java).
 * Same fields as the main-menu config screen, plus Launch Bot - this is
 * meant to be used mid-game once the bot's already been set up via the
 * main menu's "Setup Bot" button.
 *
 * IMPORTANT CAVEAT: I (Claude) could not compile or run this against the
 * actual 1.16.5/Forge 36.2.42 jars in the sandbox I built it in.
 */
public class BotieLauncherScreen extends Screen {

    private final Screen parent;

    private TextFieldWidget hostField;
    private TextFieldWidget portField;
    private TextFieldWidget usernameField;
    private TextFieldWidget mastersField;

    private Button launchButton;
    private Button stopButton;

    private String statusMessage = "";
    private boolean statusIsError = false;

    public BotieLauncherScreen(Screen parent) {
        super(new StringTextComponent("McBotAI Launcher"));
        this.parent = parent;
    }

    @Override
    protected void init() {
        int centerX = this.width / 2;
        int fieldWidth = 220;
        int fieldHeight = 20;
        int leftX = centerX - fieldWidth / 2;
        int y = 50;
        int rowGap = 36;

        this.hostField = new TextFieldWidget(
        this.font, leftX, y, fieldWidth, fieldHeight,
        new StringTextComponent("Host")
        );
        this.hostField.setMaxLength(128);
        this.hostField.setValue(McBotAIConfig.host);
        this.addButton(this.hostField);
        y += rowGap;

        this.portField = new TextFieldWidget(
        this.font, leftX, y, fieldWidth, fieldHeight,
        new StringTextComponent("Port")
        );
        this.portField.setMaxLength(6);
        this.portField.setValue(McBotAIConfig.port);
        this.addButton(this.portField);
        y += rowGap;

        this.usernameField = new TextFieldWidget(
        this.font, leftX, y, fieldWidth, fieldHeight,
        new StringTextComponent("Bot Username")
        );
        this.usernameField.setMaxLength(32);
        this.usernameField.setValue(McBotAIConfig.username);
        this.addButton(this.usernameField);
        y += rowGap;

        this.mastersField = new TextFieldWidget(
        this.font, leftX, y, fieldWidth, fieldHeight,
        new StringTextComponent("Master Username(s)")
        );
        this.mastersField.setMaxLength(128);
        this.mastersField.setValue(McBotAIConfig.masters);
        this.addButton(this.mastersField);
        y += rowGap + 16;

        // Row 1: Save + Back
        int halfWidth = (fieldWidth - 10) / 2;
        this.addButton(new Button(
                leftX, y, halfWidth, fieldHeight,
                new StringTextComponent("Save"),
                b -> this.saveConfig()
        ));
        this.addButton(new Button(
                leftX + halfWidth + 10, y, halfWidth, fieldHeight,
                new StringTextComponent("Back"),
                b -> this.onClose()
        ));

        y += fieldHeight + 6;

        // Row 2: Launch Bot + Stop Bot
        this.launchButton = new Button(
                leftX, y, halfWidth, fieldHeight,
                new StringTextComponent("Launch Bot"),
                b -> this.launchBot()
        );
        this.stopButton = new Button(
                leftX + halfWidth + 10, y, halfWidth, fieldHeight,
                new StringTextComponent("Stop Bot"),
                b -> this.stopBot()
        );
        this.updateRunningButtons();
        this.addButton(this.launchButton);
        this.addButton(this.stopButton);
    }

    @Override
    public void tick() {
        this.hostField.tick();
        this.portField.tick();
        this.usernameField.tick();
        this.mastersField.tick();
    }

    @Override
    public void render(MatrixStack matrixStack, int mouseX, int mouseY, float partialTicks) {
        // The classic tiled dirt background, same as menus like the Mods
        // list — used deliberately here instead of the blurred in-world
        // background you'd normally get from a screen opened mid-game.
        this.renderDirtBackground(0);

        AbstractGui.drawCenteredString(matrixStack, this.font, this.title, this.width / 2, 20, 0xFFFFFF);

        drawFieldLabel(matrixStack, this.hostField, "Server IP / Host");
        drawFieldLabel(matrixStack, this.portField, "Port");
        drawFieldLabel(matrixStack, this.usernameField, "Bot Username");
        drawFieldLabel(matrixStack, this.mastersField, "Master Username(s) — comma separated");

        super.render(matrixStack, mouseX, mouseY, partialTicks);

        if (!this.statusMessage.isEmpty()) {
            int color = this.statusIsError ? 0xFF5555 : 0x55FF55;
            AbstractGui.drawCenteredString(matrixStack, this.font, new StringTextComponent(this.statusMessage),
                    this.width / 2, this.mastersField.y + 86, color);
        }
    }

    private void drawFieldLabel(MatrixStack matrixStack, TextFieldWidget field, String label) {
        AbstractGui.drawString(matrixStack, this.font, label, field.x, field.y - 10, 0xA0A0A0);
    }

    @Override
    public boolean isPauseScreen() {
        return true;
    }

    @Override
    public void onClose() {
        Minecraft.getInstance().setScreen(this.parent);
    }

    // ---- Saving config ----

    private void saveConfig() {
        McBotAIConfig.host = this.hostField.getValue().trim();
        McBotAIConfig.port = this.portField.getValue().trim();
        McBotAIConfig.username = this.usernameField.getValue().trim();
        McBotAIConfig.masters = this.mastersField.getValue().trim();

        McBotAIConfig.save();

        this.setStatus("Configuration saved.", false);
    }

    // ---- Launching the bot ----

    private void updateRunningButtons() {
        boolean running = McBotAIProcess.isRunning();
        this.launchButton.active = !running;
        this.stopButton.active = running;
    }

    private void stopBot() {
        if (!McBotAIProcess.isRunning()) {
            this.setStatus("Bot isn't running.", true);
            return;
        }
        McBotAIProcess.stop();
        this.setStatus("Bot stopped.", false);
        this.updateRunningButtons();
    }

    private void launchBot() {

        if (McBotAIProcess.isRunning()) {
            // This is exactly what caused the rapid join/leave loop -
            // launching a second node.exe under the same username while
            // the first is still connected gets both of them stuck
            // fighting the server's duplicate-username kick.
            this.setStatus("Bot is already running. Use Stop Bot first if you want to restart it.", true);
            return;
        }

        File botDir = McBotAISetup.getBotDir();
        File indexFile = new File(botDir, "index.js");
        File nodeModules = new File(botDir, "node_modules");

        if (!indexFile.isFile()) {
            this.setStatus("Bot isn't set up yet - use \"Setup Bot\" in the main menu's McBotAI config first.", true);
            return;
        }
        if (!nodeModules.isDirectory()) {
            this.setStatus("Dependencies aren't installed yet - use \"Setup Bot\" in the main menu's McBotAI config first.", true);
            return;
        }
        if (!McBotAISetup.getNodeExecutable().isFile()) {
            this.setStatus("node.exe not found at " + McBotAISetup.getNodeExecutable().getAbsolutePath(), true);
            return;
        }

        String host = this.hostField.getValue().trim();
        String portText = this.portField.getValue().trim();
        String username = this.usernameField.getValue().trim();
        String mastersText = this.mastersField.getValue().trim();

        if (host.isEmpty()) {
            this.setStatus("Enter the server IP or host.", true);
            return;
        }
        int port;
        try {
            port = Integer.parseInt(portText);
        } catch (NumberFormatException e) {
            this.setStatus("Port must be a number.", true);
            return;
        }

        // Disabled immediately, synchronously, before the background
        // thread even starts - McBotAIProcess isn't registered until
        // that thread reaches pb.start(), so without this a fast enough
        // double-click could still sneak a second launch through that
        // gap even with the isRunning() check above.
        this.launchButton.active = false;

        this.setStatus("Writing configuration...", false);

        // Writing the config and spawning the process both touch the
        // filesystem/OS and shouldn't happen on the render thread either.
        new Thread(() -> {
            try {
                File configFile = new File(botDir, "config.json");
                updateConfigFile(configFile, host, port, username, mastersText);

                Minecraft.getInstance().execute(() -> this.setStatus("Starting node process...", false));

                File nodeExe = McBotAISetup.getNodeExecutable();
                File logFile = new File(botDir, "launcher.log");

                ProcessBuilder pb = new ProcessBuilder(nodeExe.getAbsolutePath(), "index.js");
                pb.directory(botDir);
                pb.redirectErrorStream(true);
                pb.redirectOutput(logFile);
                Process process = pb.start();

                // Register (and reflect in the buttons) immediately, not
                // after the alive-check below - otherwise a rapid second
                // click during that ~1.5s window could still slip past
                // the isRunning() guard and cause the exact duplicate-
                // process problem this is meant to prevent.
                McBotAIProcess.set(process);
                Minecraft.getInstance().execute(this::updateRunningButtons);

                Minecraft.getInstance().execute(() -> this.setStatus("Checking it started cleanly...", false));

                // process.start() succeeding only means the OS spawned it -
                // it doesn't mean the bot didn't immediately crash (missing
                // dependency, syntax error, bad config, etc). Give it a
                // moment and actually check.
                Thread.sleep(1500);

                if (process.isAlive()) {
                    Minecraft.getInstance().execute(() ->
                            this.setStatus("Bot is running. Output logging to launcher.log in the bot folder.", false));
                } else {
                    McBotAIProcess.stop();
                    int exitCode = process.exitValue();
                    Minecraft.getInstance().execute(() -> {
                        this.setStatus("Bot process exited immediately (code " + exitCode
                                + ") - check launcher.log in the bot folder.", true);
                        this.updateRunningButtons();
                    });
                }
            } catch (Exception e) {
                String message = e.getMessage() != null ? e.getMessage() : e.toString();
                Minecraft.getInstance().execute(() -> {
                    this.setStatus("Couldn't start the bot: " + message, true);
                    this.updateRunningButtons();
                });
            }
        }, "McBotAI-Launch").start();
    }

    private static void updateConfigFile(File configFile, String host, int port, String username, String mastersText) throws IOException {
        JsonObject config;
        if (configFile.isFile()) {
            try (InputStreamReader reader = new InputStreamReader(new FileInputStream(configFile), StandardCharsets.UTF_8)) {
                // Using the JsonParser instance method (not the newer static
                // parseReader helper) since it's the version guaranteed to
                // exist in whatever older Gson release ships bundled with
                // Minecraft 1.16.5.
                config = new JsonParser().parse(reader).getAsJsonObject();
            }
        } else {
            config = new JsonObject();
        }

        config.addProperty("host", host);
        config.addProperty("port", port);
        if (!username.isEmpty()) {
            config.addProperty("username", username);
        }

        JsonArray masters = new JsonArray();
        if (!mastersText.isEmpty()) {
            Arrays.stream(mastersText.split(","))
                    .map(String::trim)
                    .filter(s -> !s.isEmpty())
                    .forEach(masters::add);
        }
        config.add("masters", masters);

        Gson gson = new GsonBuilder().setPrettyPrinting().create();
        try (OutputStreamWriter writer = new OutputStreamWriter(new FileOutputStream(configFile), StandardCharsets.UTF_8)) {
            gson.toJson(config, writer);
        }
    }

    private void setStatus(String message, boolean isError) {
        this.statusMessage = message;
        this.statusIsError = isError;
    }
}
