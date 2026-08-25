package com.mcbotai.client;

/**
 * Tracks the single running bot process across screen open/closes - a
 * Screen instance gets thrown away and recreated every time it's opened,
 * so this can't just live as a field on BotieLauncherScreen.
 *
 * This is what a second Launch Bot click was missing: nothing stopped it
 * from spawning a second node.exe process under the same username while
 * the first was still connected. The server kicks whichever one connects
 * second (duplicate username), it reconnects per reconnectDelayMs, gets
 * kicked again, and so on forever - racing against the still-running
 * first process. That's the rapid join/leave loop.
 */
public class McBotAIProcess {

    private static Process process;

    public static synchronized boolean isRunning() {
        return process != null && process.isAlive();
    }

    public static synchronized void set(Process p) {
        process = p;
    }

    public static synchronized void stop() {
        if (process != null && process.isAlive()) {
            process.destroy();
        }
        process = null;
    }
}
